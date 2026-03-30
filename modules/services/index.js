import { EsriService } from './EsriService.js';
import { KartaviewService } from './KartaviewService.js';
import { KeepRightService } from './KeepRightService.js';
import { MapillaryService } from './MapillaryService.js';
import { MapRouletteService } from './MapRouletteService.js';
import { MapWithAIService } from './MapWithAIService.js';
import { ExternalDatasetService } from './ExternalDatasetService.js';
import { NominatimService } from './NominatimService.js';
import { NsiService } from './NsiService.js';
import { OsmService } from './OsmService.js';
import { OsmoseService } from './OsmoseService.js';
import { OsmWikibaseService } from './OsmWikibaseService.js';
import { OvertureService } from './OvertureService.js';
import { RoadAlignmentService } from './RoadAlignmentService.js';
import { StreetsideService } from './StreetsideService.js';
import { TaginfoService } from './TaginfoService.js';
import { VectorTileService } from './VectorTileService.js';
import { WikidataService } from './WikidataService.js';
import { WikipediaService } from './WikipediaService.js';
import { GeoScribbleService } from './GeoScribbleService.js';

export {
  EsriService,
  KartaviewService,
  KeepRightService,
  MapillaryService,
  MapRouletteService,
  MapWithAIService,
  ExternalDatasetService,
  NominatimService,
  NsiService,
  OsmService,
  OsmoseService,
  OsmWikibaseService,
  OvertureService,
  RoadAlignmentService,
  StreetsideService,
  TaginfoService,
  VectorTileService,
  WikidataService,
  WikipediaService
};

// At init time, we will instantiate any that are in the 'available' collection.
export const services = {
  available: new Map()  // Map (id -> Service constructor)
};

services.available.set('esri', EsriService);
services.available.set('external', ExternalDatasetService);
services.available.set('geoScribble', GeoScribbleService);
services.available.set('kartaview', KartaviewService);
services.available.set('keepRight', KeepRightService);
services.available.set('mapillary', MapillaryService);
services.available.set('maproulette', MapRouletteService);
services.available.set('mapwithai', MapWithAIService);
services.available.set('nominatim', NominatimService);
services.available.set('nsi', NsiService);
services.available.set('osm', OsmService);
services.available.set('osmose', OsmoseService);
services.available.set('osmwikibase', OsmWikibaseService);
services.available.set('overture', OvertureService);
services.available.set('roadAlignment', RoadAlignmentService);
services.available.set('streetside', StreetsideService);
services.available.set('taginfo', TaginfoService);
services.available.set('vectortile', VectorTileService);
services.available.set('wikidata', WikidataService);
services.available.set('wikipedia', WikipediaService);
