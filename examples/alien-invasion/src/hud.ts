export class Hud {
  private readonly hp = document.getElementById('hp')!;
  private readonly shells = document.getElementById('shells')!;
  private readonly kills = document.getElementById('kills')!;
  private readonly message = document.getElementById('message')!;
  private readonly warnings = document.getElementById('warnings')!;
  private readonly overlay = document.getElementById('overlay')!;
  private readonly overlayTitle = document.getElementById('overlay-title')!;
  private readonly overlayText = document.getElementById('overlay-text')!;
  private readonly overlayButton = document.getElementById('overlay-button') as HTMLButtonElement;
  private messageTimer = 0;

  constructor(onRestart: () => void) {
    this.overlayButton.addEventListener('click', onRestart);
  }

  status(hp: number, maxHp: number, shells: number, kills: number): void {
    this.hp.style.width = `${Math.max(0, (hp / maxHp) * 100)}%`;
    this.hp.classList.toggle('low', hp <= maxHp * 0.3);
    this.shells.textContent = String(shells);
    this.kills.textContent = String(kills);
  }

  say(text: string, seconds = 2.5): void {
    this.message.textContent = text;
    this.message.classList.add('visible');
    this.messageTimer = seconds;
  }

  tick(dt: number): void {
    if (this.messageTimer > 0) {
      this.messageTimer -= dt;
      if (this.messageTimer <= 0) this.message.classList.remove('visible');
    }
  }

  warn(lines: readonly string[]): void {
    this.warnings.replaceChildren(
      ...lines.map((line) => {
        const el = document.createElement('div');
        el.textContent = line;
        return el;
      }),
    );
  }

  showOverlay(title: string, text: string, button: string): void {
    this.overlayTitle.textContent = title;
    this.overlayText.textContent = text;
    this.overlayButton.textContent = button;
    this.overlay.classList.remove('hidden');
  }

  hideOverlay(): void {
    this.overlay.classList.add('hidden');
  }
}
