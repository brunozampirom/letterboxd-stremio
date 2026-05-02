export type StremioType = 'movie' | 'series';

export type StremioCatalog = {
  type: StremioType;
  id: string;
  name: string;
  extra?: { name: string; isRequired?: boolean }[];
};

export type StremioManifest = {
  id: string;
  version: string;
  name: string;
  description: string;
  resources: ('catalog' | 'meta' | 'stream')[];
  types: string[];
  idPrefixes: string[];
  catalogs: StremioCatalog[];
  behaviorHints?: { configurable?: boolean; configurationRequired?: boolean };
  logo?: string;
  background?: string;
};

export type StremioMetaPreview = {
  id: string;
  type: StremioType;
  name: string;
  releaseInfo?: string;
  poster?: string;
  background?: string;
  description?: string;
  imdbRating?: string;
  genres?: string[];
};

export type CatalogResponse = { metas: StremioMetaPreview[] };
