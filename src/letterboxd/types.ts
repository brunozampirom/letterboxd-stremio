export type LetterboxdFilm = {
  slug: string;
  title: string;
  year?: number;
  posterUrl?: string;
};

export type LetterboxdList = {
  slug: string;
  name: string;
  description?: string;
  url: string;
};
