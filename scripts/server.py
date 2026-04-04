from __future__ import annotations

import asyncio
import logging
import math
import os
import struct
from collections import OrderedDict
from concurrent.futures import ProcessPoolExecutor
from contextlib import asynccontextmanager
from typing import Any
from typing import Dict
from typing import Iterable
from typing import List
from typing import Tuple
from urllib.parse import urlencode

import httpx
import orjson
from fastapi import FastAPI
from fastapi import HTTPException
from fastapi import Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
import uvicorn


logging.basicConfig(level=logging.INFO)


# =====================================================================
# ORJSONResponse – orjson による高速 JSON シリアライズ
# =====================================================================

class ORJSONResponse(Response):
    """FastAPI 用の orjson ベースレスポンスクラス。

    標準 json モジュールの 3〜10 倍高速にシリアライズできる。
    """

    media_type = "application/json"

    def render(self, content: Any) -> bytes:
        return orjson.dumps(content, option=orjson.OPT_SERIALIZE_NUMPY)


# =====================================================================
# Vector tile (PBF) configuration
# =====================================================================

MVT_EXTENT = 4096

PBF_URL_TEMPLATE = (
    "https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/{z}/{x}/{y}.pbf"
)

ROAD_PROPERTIES = {
    "highway": "road",
}
BASE_PROPERTIES = {"source": "Extracted dynamically from GSI map"}
RAPID_BUILDING_LAYER: Tuple[str, ...] = ("building",)
RAPID_BUILDING_DATASET_ID_PREFIX = "gsi-buildings"
RAPID_BUILDING_DATASET_LABEL = "GSI Building Footprints"
RAPID_BUILDING_ITEM_URL = "https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/"
RAPID_BUILDING_LICENSE_URL = "https://maps.gsi.go.jp/development/ichiran.html"
RAPID_BUILDING_COLOR = "#da26d3"
RAPID_BUILDING_DEFAULT_Z = 16
RAPID_BUILDING_DEFAULT_LAT = 35.681236
RAPID_BUILDING_DEFAULT_LON = 139.767125
RAPID_BUILDING_SOURCE_MAX_Z = 16

DEFAULT_LAYERS: Tuple[str, ...] = ("road",)
LAYER_ALIASES = {
    "road": "road",
    "roads": "road",
    "water": "waterarea",
    "waterarea": "waterarea",
    "pond": "waterarea",
    "lake": "waterarea",
    "池": "waterarea",
    "building": "building",
    "buildings": "building",
    "建物": "building",
    "river": "river",
    "railway": "railway",
    "structurea": "structurea",
    "symbol": "symbol",
    "label": "label",
    "elevation": "elevation",
}
SUPPORTED_LAYER_NAMES = tuple(sorted(set(LAYER_ALIASES.values())))

REQUEST_TIMEOUT = httpx.Timeout(connect=10.0, read=15.0, write=5.0, pool=10.0)

MAX_RETRIES = 3
RETRY_BACKOFF_BASE = 0.5  # 0.5s, 1.0s, 2.0s

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/123.0.0.0 Safari/537.36"
)


# =====================================================================
# ProcessPoolExecutor for CPU-bound tile decoding
# =====================================================================

_executor = ProcessPoolExecutor(max_workers=os.cpu_count())


# =====================================================================
# Async tile cache with dedup lock
# =====================================================================

_TILE_CACHE_MAXSIZE = 1024
_tile_cache: OrderedDict[Tuple[int, int, int], bytes] = OrderedDict()
_tile_locks: Dict[Tuple[int, int, int], asyncio.Lock] = {}
_tile_locks_guard = asyncio.Lock() if False else None  # lazy init


def _tile_cache_put(key: Tuple[int, int, int], value: bytes) -> None:
    """LRU キャッシュにエントリを追加（maxsize を超えたら古いものから削除）"""
    _tile_cache[key] = value
    _tile_cache.move_to_end(key)
    while len(_tile_cache) > _TILE_CACHE_MAXSIZE:
        _tile_cache.popitem(last=False)


# =====================================================================
# Lifespan – httpx.AsyncClient & executor lifecycle
# =====================================================================

HTTP_CLIENT: httpx.AsyncClient | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global HTTP_CLIENT, _tile_locks_guard
    _tile_locks_guard = asyncio.Lock()
    HTTP_CLIENT = httpx.AsyncClient(
        headers={"User-Agent": _USER_AGENT},
        limits=httpx.Limits(
            max_connections=64,
            max_keepalive_connections=64,
        ),
        timeout=REQUEST_TIMEOUT,
        follow_redirects=True,
        http2=False,
    )
    yield
    await HTTP_CLIENT.aclose()
    _executor.shutdown(wait=False)


app = FastAPI(
    lifespan=lifespan,
    default_response_class=ORJSONResponse,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =====================================================================
# Coordinate utilities
# =====================================================================

def _server_port() -> int:
    port = os.getenv("PORT", "8080")
    return int(port)


def latlon_to_tile(lat: float, lon: float, zoom: int) -> Tuple[int, int]:
    lat_rad = math.radians(lat)
    n = 2.0 ** zoom
    xtile = int((lon + 180.0) / 360.0 * n)
    ytile = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return xtile, ytile


def _tilecoord_to_lonlat(px: float, py: float, z: int, x: int, y: int, extent: int = MVT_EXTENT) -> Tuple[float, float]:
    n = 2.0 ** z
    gx = x * extent + px
    gy = y * extent + py
    lon_deg = (gx / (n * extent)) * 360.0 - 180.0
    lat_rad = math.atan(math.sinh(math.pi * (1.0 - 2.0 * gy / (n * extent))))
    lat_deg = math.degrees(lat_rad)
    return lon_deg, lat_deg


def _coords_to_geojson(coords: Iterable[Tuple[int, int]], z: int, x: int, y: int, extent: int) -> List[List[float]]:
    result: List[List[float]] = []
    for px, py in coords:
        lon, lat = _tilecoord_to_lonlat(px, py, z, x, y, extent)
        result.append([lon, lat])
    return result


def _parse_layers_argument(layers: str | None) -> Tuple[str, ...]:
    if layers is None or not layers.strip():
        return DEFAULT_LAYERS

    normalized_layers: List[str] = []
    for raw_name in layers.split(","):
        name = raw_name.strip()
        if not name:
            continue

        layer_name = LAYER_ALIASES.get(name.lower()) or LAYER_ALIASES.get(name)
        if layer_name is None:
            supported = ", ".join(SUPPORTED_LAYER_NAMES)
            raise ValueError(f"Unsupported layer '{name}'. Supported layers: {supported}")

        if layer_name not in normalized_layers:
            normalized_layers.append(layer_name)

    if not normalized_layers:
        return DEFAULT_LAYERS

    return tuple(normalized_layers)


def _empty_feature_collection() -> Dict[str, Any]:
    return {"type": "FeatureCollection", "features": []}


# =====================================================================
# MVT parsing helpers
# =====================================================================

def _read_varint(data: bytes, idx: int) -> Tuple[int, int]:
    result = 0
    shift = 0
    while True:
        if idx >= len(data):
            raise ValueError("Unexpected end of data while reading varint")
        byte = data[idx]
        idx += 1
        result |= (byte & 0x7F) << shift
        if not (byte & 0x80):
            return result, idx
        shift += 7
        if shift > 70:
            raise ValueError("Varint is too long")


def _read_length_delimited(data: bytes, idx: int) -> Tuple[bytes, int]:
    length, idx = _read_varint(data, idx)
    chunk = data[idx:idx + length]
    if len(chunk) != length:
        raise ValueError("Unexpected end of data while reading length-delimited field")
    return chunk, idx + length


def _zigzag_decode(n: int) -> int:
    return (n >> 1) ^ (-(n & 1))


def _parse_value(msg: bytes) -> Any:
    idx = 0
    value: Any = None

    while idx < len(msg):
        key, idx = _read_varint(msg, idx)
        field = key >> 3
        wt = key & 7

        if field == 1 and wt == 2:
            raw, idx = _read_length_delimited(msg, idx)
            value = raw.decode("utf-8", errors="replace")
        elif field == 2 and wt == 5:
            value = struct.unpack("<f", msg[idx:idx + 4])[0]
            idx += 4
        elif field == 3 and wt == 1:
            value = struct.unpack("<d", msg[idx:idx + 8])[0]
            idx += 8
        elif field == 4 and wt == 0:
            value, idx = _read_varint(msg, idx)
        elif field == 5 and wt == 0:
            value, idx = _read_varint(msg, idx)
        elif field == 6 and wt == 0:
            value, idx = _read_varint(msg, idx)
            value = _zigzag_decode(value)
        elif field == 7 and wt == 0:
            v, idx = _read_varint(msg, idx)
            value = bool(v)
        else:
            if wt == 0:
                _, idx = _read_varint(msg, idx)
            elif wt == 1:
                idx += 8
            elif wt == 5:
                idx += 4
            elif wt == 2:
                _, idx = _read_length_delimited(msg, idx)
            else:
                raise ValueError(f"Unsupported wire type in Value: {wt}")

    return value


def _parse_feature(msg: bytes) -> Dict[str, Any]:
    idx = 0
    feature = {"id": None, "tags": [], "type": None, "geometry": []}

    while idx < len(msg):
        key, idx = _read_varint(msg, idx)
        field = key >> 3
        wt = key & 7

        if field == 1 and wt == 0:
            feature["id"], idx = _read_varint(msg, idx)
        elif field == 2 and wt == 2:
            raw, idx = _read_length_delimited(msg, idx)
            j = 0
            while j < len(raw):
                v, j = _read_varint(raw, j)
                feature["tags"].append(v)
        elif field == 3 and wt == 0:
            feature["type"], idx = _read_varint(msg, idx)
        elif field == 4 and wt == 2:
            raw, idx = _read_length_delimited(msg, idx)
            j = 0
            while j < len(raw):
                v, j = _read_varint(raw, j)
                feature["geometry"].append(v)
        else:
            if wt == 0:
                _, idx = _read_varint(msg, idx)
            elif wt == 1:
                idx += 8
            elif wt == 5:
                idx += 4
            elif wt == 2:
                _, idx = _read_length_delimited(msg, idx)
            else:
                raise ValueError(f"Unsupported wire type in Feature: {wt}")

    return feature


def _parse_layer(msg: bytes) -> Dict[str, Any]:
    idx = 0
    layer = {
        "name": None,
        "version": None,
        "extent": MVT_EXTENT,
        "keys": [],
        "values": [],
        "features": [],
    }

    while idx < len(msg):
        key, idx = _read_varint(msg, idx)
        field = key >> 3
        wt = key & 7

        if field == 1 and wt == 2:
            raw, idx = _read_length_delimited(msg, idx)
            layer["name"] = raw.decode("utf-8", errors="replace")
        elif field == 2 and wt == 2:
            raw, idx = _read_length_delimited(msg, idx)
            layer["features"].append(_parse_feature(raw))
        elif field == 3 and wt == 2:
            raw, idx = _read_length_delimited(msg, idx)
            layer["keys"].append(raw.decode("utf-8", errors="replace"))
        elif field == 4 and wt == 2:
            raw, idx = _read_length_delimited(msg, idx)
            layer["values"].append(_parse_value(raw))
        elif field == 5 and wt == 0:
            layer["extent"], idx = _read_varint(msg, idx)
        elif field == 15 and wt == 0:
            layer["version"], idx = _read_varint(msg, idx)
        else:
            if wt == 0:
                _, idx = _read_varint(msg, idx)
            elif wt == 1:
                idx += 8
            elif wt == 5:
                idx += 4
            elif wt == 2:
                _, idx = _read_length_delimited(msg, idx)
            else:
                raise ValueError(f"Unsupported wire type in Layer: {wt}")

    return layer


def _parse_tile(data: bytes) -> List[Dict[str, Any]]:
    idx = 0
    layers = []

    while idx < len(data):
        key, idx = _read_varint(data, idx)
        field = key >> 3
        wt = key & 7

        if field == 3 and wt == 2:
            raw, idx = _read_length_delimited(data, idx)
            layers.append(_parse_layer(raw))
        else:
            if wt == 0:
                _, idx = _read_varint(data, idx)
            elif wt == 1:
                idx += 8
            elif wt == 5:
                idx += 4
            elif wt == 2:
                _, idx = _read_length_delimited(data, idx)
            else:
                raise ValueError(f"Unsupported wire type in Tile: {wt}")

    return layers


def _decode_geometry_commands(commands: List[int]) -> List[Tuple[List[Tuple[int, int]], bool]]:
    x = 0
    y = 0
    i = 0
    parts: List[Tuple[List[Tuple[int, int]], bool]] = []
    current: List[Tuple[int, int]] = []
    current_closed = False

    while i < len(commands):
        cmd_length = commands[i]
        i += 1
        cmd = cmd_length & 0x7
        count = cmd_length >> 3

        if cmd == 1:
            for _ in range(count):
                if i + 1 >= len(commands):
                    raise ValueError("MoveTo command is truncated")
                dx = _zigzag_decode(commands[i])
                dy = _zigzag_decode(commands[i + 1])
                i += 2
                x += dx
                y += dy
                if current:
                    parts.append((current, current_closed))
                current = []
                current_closed = False
                current.append((x, y))

        elif cmd == 2:
            for _ in range(count):
                if i + 1 >= len(commands):
                    raise ValueError("LineTo command is truncated")
                if not current:
                    raise ValueError("LineTo command appeared before MoveTo")
                dx = _zigzag_decode(commands[i])
                dy = _zigzag_decode(commands[i + 1])
                i += 2
                x += dx
                y += dy
                current.append((x, y))

        elif cmd == 7:
            if current:
                current_closed = True

        else:
            raise ValueError(f"Unknown MVT command: {cmd}")

    if current:
        parts.append((current, current_closed))

    return parts


def _decode_tags(feature: Dict[str, Any], keys: List[str], values: List[Any]) -> Dict[str, Any]:
    tags = feature.get("tags", [])
    props: Dict[str, Any] = {}

    for i in range(0, len(tags), 2):
        if i + 1 >= len(tags):
            break
        key_idx = tags[i]
        val_idx = tags[i + 1]
        if 0 <= key_idx < len(keys) and 0 <= val_idx < len(values):
            props[keys[key_idx]] = values[val_idx]

    return props


def _close_ring_if_needed(coords: List[Tuple[int, int]]) -> List[Tuple[int, int]]:
    if not coords:
        return coords
    if coords[0] == coords[-1]:
        return coords
    return [*coords, coords[0]]


def _ring_signed_area(ring: List[Tuple[int, int]]) -> float:
    area = 0.0
    for i in range(len(ring) - 1):
        x0, y0 = ring[i]
        x1, y1 = ring[i + 1]
        area += (x0 * y1) - (x1 * y0)
    return area * 0.5


def _geometry_for_type(
    geometry_type: int,
    parts: List[Tuple[List[Tuple[int, int]], bool]],
    z: int,
    x: int,
    y: int,
    extent: int,
) -> Dict[str, Any] | None:
    if geometry_type == 1:
        points: List[List[float]] = []
        for coords, _ in parts:
            if not coords:
                continue
            px, py = coords[0]
            lon, lat = _tilecoord_to_lonlat(px, py, z, x, y, extent)
            points.append([lon, lat])
        if not points:
            return None
        if len(points) == 1:
            return {"type": "Point", "coordinates": points[0]}
        return {"type": "MultiPoint", "coordinates": points}

    if geometry_type == 2:
        line_parts: List[List[List[float]]] = []
        for coords, _ in parts:
            if len(coords) < 2:
                continue
            line_parts.append(_coords_to_geojson(coords, z, x, y, extent))
        if not line_parts:
            return None
        if len(line_parts) == 1:
            return {"type": "LineString", "coordinates": line_parts[0]}
        return {"type": "MultiLineString", "coordinates": line_parts}

    if geometry_type == 3:
        rings: List[List[Tuple[int, int]]] = []
        for coords, _ in parts:
            if len(coords) < 3:
                continue
            ring = _close_ring_if_needed(coords)
            if len(ring) < 4:
                continue
            rings.append(ring)
        if not rings:
            return None

        polygons: List[List[List[Tuple[int, int]]]] = []
        current_polygon: List[List[Tuple[int, int]]] | None = None
        for ring in rings:
            is_outer = _ring_signed_area(ring) > 0
            if is_outer or current_polygon is None:
                if current_polygon:
                    polygons.append(current_polygon)
                current_polygon = [ring]
            else:
                current_polygon.append(ring)

        if current_polygon:
            polygons.append(current_polygon)
        if not polygons:
            return None

        if len(polygons) == 1:
            coordinates = [_coords_to_geojson(ring, z, x, y, extent) for ring in polygons[0]]
            return {"type": "Polygon", "coordinates": coordinates}

        coordinates = []
        for polygon in polygons:
            polygon_coords = [_coords_to_geojson(ring, z, x, y, extent) for ring in polygon]
            coordinates.append(polygon_coords)
        return {"type": "MultiPolygon", "coordinates": coordinates}

    return None


def _decode_selected_layers(
    pbf_bytes: bytes,
    z: int,
    x: int,
    y: int,
    target_layers: Tuple[str, ...],
    include_all_roads: bool = False,
) -> Dict[str, Any]:
    layers = _parse_tile(pbf_bytes)
    layer_by_name = {layer.get("name"): layer for layer in layers}
    features: List[Dict[str, Any]] = []

    for layer_name in target_layers:
        layer = layer_by_name.get(layer_name)
        if layer is None:
            continue

        extent = int(layer.get("extent") or MVT_EXTENT)

        for feature in layer["features"]:
            parts = _decode_geometry_commands(feature.get("geometry", []))
            if not parts:
                continue

            parsed_props = _decode_tags(feature, layer["keys"], layer["values"])

            if layer_name == "road" and (not include_all_roads) and "rdCtg" not in parsed_props:
                continue

            geometry = _geometry_for_type(int(feature.get("type") or 0), parts, z, x, y, extent)
            if geometry is None:
                continue

            props = dict(BASE_PROPERTIES)
            props["layer"] = layer_name
            if layer_name == "road":
                props.update(ROAD_PROPERTIES)
            props.update(parsed_props)

            feature_id = feature.get("id")
            if feature_id is not None:
                props["mvt_id"] = feature_id

            features.append(
                {
                    "type": "Feature",
                    "properties": props,
                    "geometry": geometry,
                }
            )

    return {"type": "FeatureCollection", "features": features}


# =====================================================================
# Async tile fetching with dedup lock
# =====================================================================

class TileFetchError(RuntimeError):
    pass


async def _get_tile_lock(key: Tuple[int, int, int]) -> asyncio.Lock:
    """タイルキーに対応する asyncio.Lock を取得（なければ作成）"""
    global _tile_locks_guard
    if _tile_locks_guard is None:
        _tile_locks_guard = asyncio.Lock()
    async with _tile_locks_guard:
        if key not in _tile_locks:
            _tile_locks[key] = asyncio.Lock()
        return _tile_locks[key]


async def _fetch_tile_pbf_cached(z: int, x: int, y: int) -> bytes:
    """非同期タイルフェッチ + LRU キャッシュ + dedup lock + リトライ

    同一タイルへの同時リクエストは 1 回のフェッチだけ実行し、
    他のリクエストはそのフェッチの完了を待つ。
    タイムアウトやネットワークエラー時は指数バックオフでリトライする。
    """
    key = (z, x, y)

    # キャッシュヒット（ロック不要で高速パス）
    if key in _tile_cache:
        _tile_cache.move_to_end(key)
        return _tile_cache[key]

    # dedup lock を取得
    lock = await _get_tile_lock(key)
    async with lock:
        # double-check: 別のリクエストがフェッチ済みかもしれない
        if key in _tile_cache:
            _tile_cache.move_to_end(key)
            return _tile_cache[key]

        url = PBF_URL_TEMPLATE.format(z=z, x=x, y=y)
        last_error: Exception | None = None

        for attempt in range(MAX_RETRIES):
            try:
                resp = await HTTP_CLIENT.get(url)
            except httpx.RequestError as err:
                last_error = err
                if attempt < MAX_RETRIES - 1:
                    wait = RETRY_BACKOFF_BASE * (2 ** attempt)
                    logging.warning(
                        "tile fetch attempt %d/%d failed (network: %s), retrying in %.1fs - URL: %s",
                        attempt + 1, MAX_RETRIES, type(err).__name__, wait, url,
                    )
                    await asyncio.sleep(wait)
                    continue
                raise TileFetchError(
                    f"tile fetch failed after {MAX_RETRIES} retries "
                    f"(network error): {type(err).__name__}: {err} - URL: {url}"
                ) from err

            if resp.status_code == 404:
                _tile_cache_put(key, b"")
                return b""

            if resp.status_code >= 500 and attempt < MAX_RETRIES - 1:
                # サーバーエラーはリトライ対象
                wait = RETRY_BACKOFF_BASE * (2 ** attempt)
                logging.warning(
                    "tile fetch attempt %d/%d got HTTP %d, retrying in %.1fs - URL: %s",
                    attempt + 1, MAX_RETRIES, resp.status_code, wait, url,
                )
                await asyncio.sleep(wait)
                continue

            if resp.status_code >= 400:
                raise TileFetchError(
                    f"tile fetch failed: HTTP {resp.status_code} - URL: {url}"
                )

            if not resp.content:
                _tile_cache_put(key, b"")
                return b""

            _tile_cache_put(key, resp.content)
            return resp.content

        # ここに到達するのは全リトライが 5xx で失敗した場合のみ
        raise TileFetchError(
            f"tile fetch failed after {MAX_RETRIES} retries: HTTP 5xx - URL: {url}"
        )


async def fetch_and_process(
    z: int,
    x: int,
    y: int,
    target_layers: Tuple[str, ...],
    include_all_roads: bool = False,
) -> Dict[str, Any]:
    """非同期タイルフェッチ + ProcessPoolExecutor でデコードを並列化"""
    try:
        pbf_bytes = await _fetch_tile_pbf_cached(z, x, y)
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            _executor,
            _decode_selected_layers,
            pbf_bytes,
            z,
            x,
            y,
            target_layers,
            include_all_roads,
        )
        return result
    except (TileFetchError, ValueError) as err:
        logging.error("tile processing failed: %s", err)
        return _empty_feature_collection()


def _resolve_tile_request(
    z: int,
    x: int | None,
    y: int | None,
    lat: float | None,
    lon: float | None,
    allow_default: bool = False,
) -> Tuple[int, int, int]:
    has_tile = x is not None or y is not None
    has_latlon = lat is not None or lon is not None

    if has_tile and has_latlon:
        raise HTTPException(
            status_code=400,
            detail="Specify either x/y tile coordinates or lat/lon coordinates, not both",
        )

    if has_tile:
        if x is None or y is None:
            raise HTTPException(
                status_code=400,
                detail="x and y must both be provided when using tile coordinates",
            )
        return z, x, y

    if has_latlon:
        if lat is None or lon is None:
            raise HTTPException(
                status_code=400,
                detail="lat and lon must both be provided when using lat/lon coordinates",
            )

        tile_x, tile_y = latlon_to_tile(lat, lon, z)
        return z, tile_x, tile_y

    if allow_default:
        tile_x, tile_y = latlon_to_tile(
            RAPID_BUILDING_DEFAULT_LAT,
            RAPID_BUILDING_DEFAULT_LON,
            z,
        )
        return z, tile_x, tile_y

    raise HTTPException(
        status_code=400,
        detail="Provide either x/y tile coordinates or lat/lon coordinates",
    )


def _to_rapid_building_feature_collection(feature_collection: Dict[str, Any], z: int, x: int, y: int) -> Dict[str, Any]:
    rapid_features: List[Dict[str, Any]] = []

    for index, feature in enumerate(feature_collection.get("features", []), start=1):
        if not isinstance(feature, dict):
            continue

        geometry = feature.get("geometry")
        if not isinstance(geometry, dict):
            continue

        geometry_type = geometry.get("type")
        if geometry_type not in ("Polygon", "MultiPolygon"):
            continue

        raw_props = feature.get("properties")
        source_props = raw_props if isinstance(raw_props, dict) else {}

        mvt_id = source_props.get("mvt_id")
        feature_id = f"{z}-{x}-{y}-{mvt_id}" if mvt_id is not None else f"{z}-{x}-{y}-{index}"

        properties: Dict[str, Any] = {
            "building": "yes",
            "source": source_props.get("source", BASE_PROPERTIES["source"]),
        }

        name = source_props.get("name")
        if isinstance(name, str) and name.strip():
            properties["@name"] = name

        rapid_features.append(
            {
                "type": "Feature",
                "id": str(feature_id),
                "properties": properties,
                "geometry": geometry,
            }
        )

    return {"type": "FeatureCollection", "features": rapid_features}


def _to_rapid_building_source_tile(z: int, x: int, y: int) -> Tuple[int, int, int]:
    if z <= RAPID_BUILDING_SOURCE_MAX_Z:
        return z, x, y

    shift = z - RAPID_BUILDING_SOURCE_MAX_Z
    return RAPID_BUILDING_SOURCE_MAX_Z, (x >> shift), (y >> shift)


def _build_rapid_building_manifest(source_url: str) -> Dict[str, Any]:
    return {
        "version": 1,
        "datasets": [
            {
                "id": RAPID_BUILDING_DATASET_ID_PREFIX,
                "label": RAPID_BUILDING_DATASET_LABEL,
                "description": "Building footprints extracted from the GSI experimental vector tile.",
                "categories": ["buildings"],
                "source": {
                    "type": "geojson",
                    "url": source_url,
                },
                "itemUrl": RAPID_BUILDING_ITEM_URL,
                "licenseUrl": RAPID_BUILDING_LICENSE_URL,
                "color": RAPID_BUILDING_COLOR,
            }
        ],
    }


def _build_rapid_building_tile_template_url(request: Request) -> str:
    base_url = str(request.base_url.replace(scheme="https")).rstrip("/")
    return f"{base_url}/rapid/buildings/{{z}}/{{x}}/{{y}}.geojson"


# =====================================================================
# FastAPI endpoints (all async)
# =====================================================================

@app.get("/tile/{z}/{x}/{y}.geojson")
async def get_geojson_from_xyz(
    z: int,
    x: int,
    y: int,
    layers: str = "road",
    include_all_roads: bool = False,
):
    try:
        target_layers = _parse_layers_argument(layers)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    return await fetch_and_process(z, x, y, target_layers, include_all_roads)


@app.get("/geojson")
async def get_geojson_from_latlon(
    lat: float,
    lon: float,
    z: int = 16,
    layers: str = "road",
    include_all_roads: bool = False,
):
    if lat is None or lon is None:
        raise HTTPException(status_code=400, detail="lat and lon parameters are required")

    try:
        target_layers = _parse_layers_argument(layers)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err

    x, y = latlon_to_tile(lat, lon, z)
    return await fetch_and_process(z, x, y, target_layers, include_all_roads)


@app.get("/rapid/buildings.geojson")
async def get_rapid_buildings_geojson(
    z: int = RAPID_BUILDING_DEFAULT_Z,
    x: int | None = None,
    y: int | None = None,
    lat: float | None = None,
    lon: float | None = None,
):
    z, x, y = _resolve_tile_request(z, x, y, lat, lon, allow_default=True)
    source_z, source_x, source_y = _to_rapid_building_source_tile(z, x, y)
    feature_collection = await fetch_and_process(source_z, source_x, source_y, RAPID_BUILDING_LAYER)
    return _to_rapid_building_feature_collection(feature_collection, source_z, source_x, source_y)


@app.get("/rapid/buildings/{z}/{x}/{y}.geojson")
async def get_rapid_buildings_geojson_tile(
    z: int,
    x: int,
    y: int,
):
    source_z, source_x, source_y = _to_rapid_building_source_tile(z, x, y)
    feature_collection = await fetch_and_process(source_z, source_x, source_y, RAPID_BUILDING_LAYER)
    return _to_rapid_building_feature_collection(feature_collection, source_z, source_x, source_y)


@app.get("/rapid/buildings.manifest.json")
async def get_rapid_buildings_manifest(
    request: Request,
    z: int = RAPID_BUILDING_DEFAULT_Z,
    x: int | None = None,
    y: int | None = None,
    lat: float | None = None,
    lon: float | None = None,
):
    has_explicit_target = x is not None or y is not None or lat is not None or lon is not None

    if has_explicit_target:
        z, x, y = _resolve_tile_request(z, x, y, lat, lon, allow_default=True)
        base_url = str(request.url_for("get_rapid_buildings_geojson").replace(scheme="https"))
        query = urlencode({"z": z, "x": x, "y": y})
        source_url = f"{base_url}?{query}"
    else:
        source_url = _build_rapid_building_tile_template_url(request)

    return _build_rapid_building_manifest(source_url)


app.mount("/", StaticFiles(directory=".", html=True, follow_symlink=True), name="static")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=_server_port(), log_level="info")
