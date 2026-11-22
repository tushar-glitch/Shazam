const svgNs = 'http://www.w3.org/2000/svg';

// Song names are stored as "Artist - Title"
export function splitName(name: string): { artist: string; title: string } {
    const split = name.indexOf(' - ');
    return split > 0 ? { artist: name.slice(0, split), title: name.slice(split + 3) } : { artist: '', title: name };
}

// Cover image URLs by song name, from GET /api/songs
let images: Readonly<Record<string, string>> = {};

export function setSongImages(map: Readonly<Record<string, string>>): void {
    images = map;
}

// The song's cover image if it has one, otherwise (or if the image fails to load) its constellation.
// Small covers ask for the 150 px version of the image where the URL has a size in it.
export function drawCover(element: HTMLElement, song: string, size: 'small' | 'large' = 'small'): void {
    const url = images[song];
    if (!url) return drawGlyph(element, song);

    const image = document.createElement('img');
    image.alt = '';
    image.decoding = 'async';
    image.loading = size === 'small' ? 'lazy' : 'eager';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => drawGlyph(element, song), { once: true });
    image.src = size === 'small' ? url.replace(/-\d+x\d+(\.\w+)$/, '-150x150$1') : url;
    element.classList.add('has-image');
    element.replaceChildren(image);
}

// No artwork: every song gets its own small constellation, derived from its name, so the same
// song always draws the same stars. The brightest star is in the signal colour.
export function drawGlyph(element: HTMLElement, song: string): void {
    element.classList.remove('has-image');
    const random = seeded(hash(song));
    const count = 5 + Math.floor(random() * 3);
    const cells = new Set<number>();
    while (cells.size < count) cells.add(Math.floor(random() * 25)); // a 5 × 5 grid

    // Each star sits somewhere inside its cell; the line joins them left to right
    const stars = [...cells]
        .map(cell => ({ x: 3 + (cell % 5) * 4.5 + random() * 2, y: 3 + Math.floor(cell / 5) * 4.5 + random() * 2, r: 0.7 + random() * 0.6 }))
        .sort((a, b) => a.x - b.x);
    const brightest = Math.floor(random() * stars.length);

    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 26 26');
    svg.setAttribute('aria-hidden', 'true');
    for (let i = 1; i < stars.length; i++) {
        const line = document.createElementNS(svgNs, 'line');
        line.setAttribute('x1', stars[i - 1]!.x.toFixed(2));
        line.setAttribute('y1', stars[i - 1]!.y.toFixed(2));
        line.setAttribute('x2', stars[i]!.x.toFixed(2));
        line.setAttribute('y2', stars[i]!.y.toFixed(2));
        svg.append(line);
    }
    stars.forEach((star, i) => {
        const dot = document.createElementNS(svgNs, 'circle');
        dot.setAttribute('cx', star.x.toFixed(2));
        dot.setAttribute('cy', star.y.toFixed(2));
        dot.setAttribute('r', (i === brightest ? 1.7 : star.r).toFixed(2));
        if (i === brightest) dot.classList.add('star');
        svg.append(dot);
    });
    element.replaceChildren(svg);
}

// One list row: glyph · title + artist · a short aside (plain information, not a link)
export function songRow(song: string, aside = ''): HTMLLIElement {
    const { artist, title } = splitName(song);
    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    drawCover(glyph, song);

    const text = document.createElement('span');
    text.className = 'row-text';
    const titleEl = document.createElement('strong');
    titleEl.textContent = title;
    const artistEl = document.createElement('span');
    artistEl.textContent = artist || 'Unknown artist';
    text.append(titleEl, artistEl);

    const asideEl = document.createElement('span');
    asideEl.className = 'row-aside mono';
    asideEl.textContent = aside;

    const row = document.createElement('li');
    row.append(glyph, text, asideEl);
    return row;
}

// FNV-1a: a stable 32-bit number for a string
function hash(text: string): number {
    let h = 0x811c9dc5;
    for (const char of text) h = Math.imul(h ^ char.codePointAt(0)!, 0x01000193) >>> 0;
    return h;
}

// mulberry32: small deterministic random numbers from a seed
function seeded(seed: number): () => number {
    let state = seed;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
