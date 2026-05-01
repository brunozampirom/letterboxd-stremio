import { LetterboxdFilm } from '../letterboxd/types';
import { StremioMetaPreview } from './types';

export function toMetaPreview(film: LetterboxdFilm, imdbId: string): StremioMetaPreview {
  return {
    id: imdbId,
    type: 'movie',
    name: film.title,
    releaseInfo: film.year ? String(film.year) : undefined,
  };
}
