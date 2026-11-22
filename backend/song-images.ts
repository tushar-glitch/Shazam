import fs from 'node:fs';

// Cover image URL per song ("Artist - Title" → https URL), from the metadata file the licensed
// fetcher writes ({ [song]: { id, image_url } }). Missing file or bad entries = no image.
// Only https links are kept, since they are put into <img src> in the browser.
export function loadSongImages(file: string): Record<string, string> {
    if (!fs.existsSync(file)) return {};
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, { image_url?: unknown }>;
        const images: Record<string, string> = {};
        for (const [song, entry] of Object.entries(data)) {
            const url = entry?.image_url;
            if (typeof url === 'string' && /^https:\/\//.test(url) && URL.canParse(url)) images[song] = url;
        }
        return images;
    } catch (error) {
        console.error(`Could not read song images from ${file}: ${(error as Error).message}`);
        return {};
    }
}
