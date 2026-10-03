// Bridge decks at street level (a road crossing a railway cutting or a river). Under them the terrain
// dips, but everything on the bridge must stay at deck level.
//
// A deck is { pts: [x, y, z, ...], half }: the bridge centreline at deck level, bank to bank, and the half
// width of the corridor around it. The compiler marks each road polygon that belongs to a bridge with the
// index of its deck (area.code = DECK_FLAG | index), because a bridge can be far wider than its carriageway
// (a plaza over the tracks): those polygons are held at deck level across the whole gap, whatever their
// distance from the centreline.
import { sampleGrid } from './terrain.js';

export const DECK_FLAG = 0x8000;
export const deckOf = (code) => (code & DECK_FLAG ? code & 0x7fff : -1);

// Nearest point of the deck centreline to (x, z): { dist, y, inside }. `inside` is false beyond either
// bank, where the ground takes over again.
export function projectOnDeck(deck, x, z) {
  const p = deck.pts, last = p.length / 3 - 1;
  let best = { dist: Infinity, y: 0, inside: false };
  for (let i = 1; i <= last; i++) {
    const ax = p[i * 3 - 3], ay = p[i * 3 - 2], az = p[i * 3 - 1], dx = p[i * 3] - ax, dz = p[i * 3 + 2] - az;
    const raw = ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1), t = Math.max(0, Math.min(1, raw));
    const dist = Math.hypot(x - ax - dx * t, z - az - dz * t);
    if (dist < best.dist) best = { dist, y: ay + (p[i * 3 + 1] - ay) * t, inside: !(i === 1 && raw <= 0) && !(i === last && raw >= 1) };
  }
  return best;
}

// Returns surface(x, z, deck = -1): the height to stand on. With a deck index, that deck's level between
// its banks; without, the level of any deck whose corridor contains the point (street objects); the
// terrain otherwise.
export function makeSurface(grid, decks) {
  return (x, z, deck = -1) => {
    let y = sampleGrid(grid, x, z);
    if (deck >= 0) {
      const p = projectOnDeck(decks[deck], x, z);
      if (p.inside) y = Math.max(y, p.y);
    } else {
      for (const d of decks) {
        const p = projectOnDeck(d, x, z);
        if (p.inside && p.dist <= d.half) y = Math.max(y, p.y);
      }
    }
    return y;
  };
}
