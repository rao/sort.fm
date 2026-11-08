export const audioFields = [
	["energy", "Energy"],
	["danceability", "Danceability"],
	["happiness", "Happiness"],
	["acousticness", "Acousticness"],
	["instrumentalness", "Instrumentalness"],
	["liveness", "Liveness"],
	["speechiness", "Speechiness"],
	["tempo_bpm", "Tempo"],
	["loudness_db", "Loudness"],
] as const;
export type AudioKey = (typeof audioFields)[number][0];
