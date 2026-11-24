export interface Vec {
  x: number;
  y: number;
}

export interface InputState {
  /** Unit-or-shorter movement vector, +y forward on screen. */
  readonly move: Vec;
  /** Where the mouse points on the play plane, in normalized device coordinates. */
  readonly pointer: Vec | null;
  /** A direct aim direction from the right stick, when touch is in use. */
  readonly stickAim: Vec | null;
  readonly fire: boolean;
}

export class Input {
  private readonly keys = new Set<string>();
  private pointer: Vec | null = null;
  private mouseDown = false;
  private readonly sticks = { move: new Stick('stick-move'), aim: new Stick('stick-aim') };
  readonly touch = matchMedia('(pointer: coarse)').matches;

  constructor(canvas: HTMLCanvasElement) {
    addEventListener('keydown', (e) => {
      if (!e.repeat) this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('mousemove', (e) => {
      this.pointer = {
        x: (e.clientX / canvas.clientWidth) * 2 - 1,
        y: -(e.clientY / canvas.clientHeight) * 2 + 1,
      };
    });
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.mouseDown = true;
    });
    addEventListener('mouseup', () => (this.mouseDown = false));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.getElementById('sticks')?.classList.toggle('visible', this.touch);
  }

  read(): InputState {
    let x = 0;
    let y = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y -= 1;
    const l = Math.hypot(x, y);
    let move: Vec = l > 1 ? { x: x / l, y: y / l } : { x, y };
    const stickMove = this.sticks.move.value;
    if (stickMove) move = { x: stickMove.x, y: -stickMove.y };
    const aim = this.sticks.aim.value;
    const stickAim = aim && Math.hypot(aim.x, aim.y) > 0.3 ? { x: aim.x, y: -aim.y } : null;
    return {
      move,
      pointer: this.pointer,
      stickAim,
      fire: this.mouseDown || this.keys.has('Space') || (stickAim !== null && Math.hypot(aim!.x, aim!.y) > 0.6),
    };
  }
}

class Stick {
  value: Vec | null = null;
  private pointerId: number | null = null;
  private readonly element: HTMLElement;
  private readonly knob: HTMLElement;

  constructor(id: string) {
    this.element = document.getElementById(id)!;
    this.knob = this.element.querySelector('.knob')!;
    this.element.addEventListener('pointerdown', (e) => {
      this.pointerId = e.pointerId;
      this.element.setPointerCapture(e.pointerId);
      this.update(e);
    });
    this.element.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.pointerId) this.update(e);
    });
    const release = (e: PointerEvent) => {
      if (e.pointerId !== this.pointerId) return;
      this.pointerId = null;
      this.value = null;
      this.knob.style.transform = '';
    };
    this.element.addEventListener('pointerup', release);
    this.element.addEventListener('pointercancel', release);
  }

  private update(e: PointerEvent): void {
    const rect = this.element.getBoundingClientRect();
    const radius = rect.width / 2;
    let dx = (e.clientX - (rect.left + radius)) / radius;
    let dy = (e.clientY - (rect.top + radius)) / radius;
    const l = Math.hypot(dx, dy);
    if (l > 1) {
      dx /= l;
      dy /= l;
    }
    this.value = { x: dx, y: dy };
    this.knob.style.transform = `translate(${dx * radius * 0.6}px, ${dy * radius * 0.6}px)`;
  }
}
