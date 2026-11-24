import levelUrl from '../_blender/levels/outpost.lm?url';
import { Game } from './game.ts';
import { Hud } from './hud.ts';
import { Input } from './input.ts';
import { loadLevel } from './level.ts';
import { View } from './render.ts';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const view = new View(canvas);
const input = new Input(canvas);
let game: Game | null = null;
const hud = new Hud(() => void start());

async function start(): Promise<void> {
  hud.hideOverlay();
  const level = await loadLevel(levelUrl, 'outpost');
  hud.warn(level.scene.warnings);
  game?.dispose();
  game = new Game(level, view, hud);
  if (import.meta.env.DEV) Object.assign(window, { game });
  hud.say('Find the exit.', 3);
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (game) game.update(dt, input.read());
  hud.tick(dt);
  view.tick(dt);
  view.render();
  requestAnimationFrame(frame);
}

start().catch((error: unknown) => {
  console.error(error);
  hud.showOverlay('LOAD FAILED', error instanceof Error ? error.message : String(error), 'Retry');
});
requestAnimationFrame(frame);
