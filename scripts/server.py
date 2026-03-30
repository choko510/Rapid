from __future__ import annotations

import logging
import math
import os
import struct
from functools import lru_cache
from typing import Any
from typing import Dict
from typing import Iterable
from typing import List
from typing import Tuple

import requests
from fastapi import FastAPI
from fastapi import HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from requests.adapters import HTTPAdapter
import uvicorn


logging.basicConfig(level=logging.INFO)

app = FastAPI()


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

REQUEST_TIMEOUT = (3.0, 10.0)

HTTP_SESSION = requests.Session()
HTTP_SESSION.headers.update(
    {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/123.0.0.0 Safari/537.36"
        )
    }
)
HTTP_SESSION.mount(
    "https://",
    HTTPAdapter(pool_connections=64, pool_maxsize=64, max_retries=0),
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


class TileFetchError(RuntimeError):
    pass


@lru_cache(maxsize=1024)
def _fetch_tile_pbf_cached(z: int, x: int, y: int) -> bytes:
    url = PBF_URL_TEMPLATE.format(z=z, x=x, y=y)

    try:
        resp = HTTP_SESSION.get(url, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
    except requests.RequestException as err:
        raise TileFetchError(f"tile fetch failed: {err}") from err

    if not resp.content:
        raise TileFetchError("empty PBF payload")

    return resp.content


def fetch_and_process(
    z: int,
    x: int,
    y: int,
    target_layers: Tuple[str, ...],
    include_all_roads: bool = False,
) -> Dict[str, Any]:
    try:
        pbf_bytes = _fetch_tile_pbf_cached(z, x, y)
        return _decode_selected_layers(pbf_bytes, z, x, y, target_layers, include_all_roads)
    except (TileFetchError, ValueError) as err:
        logging.error("tile processing failed: %s", err)
        return _empty_feature_collection()


@app.get("/tile/{z}/{x}/{y}.geojson")
def get_geojson_from_xyz(
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
    return fetch_and_process(z, x, y, target_layers, include_all_roads)


@app.get("/geojson")
def get_geojson_from_latlon(
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
    return fetch_and_process(z, x, y, target_layers, include_all_roads)


app.mount("/", StaticFiles(directory=".", html=True, follow_symlink=True), name="static")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=_server_port(), log_level="info")
