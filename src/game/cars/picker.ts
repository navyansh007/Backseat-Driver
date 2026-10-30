import { CARS, carInfo } from '../../shared/cars';

const STATS = [['speed', 'speed'], ['accel', 'accel'], ['grip', 'grip'], ['weight', 'weight']] as const;

/**
 * The car picker on the title screen: arrows either side of the name, the car's line and its bars.
 * It lists whatever is in CARS, so a new car shows up here by itself.
 */
export class CarPicker {
  private maker: HTMLElement;
  private model: HTMLElement;
  private blurb: HTMLElement;
  private bars: Record<string, HTMLElement> = {};
  private dots: HTMLElement[] = [];
  private id: string;

  constructor(root: HTMLElement, id: string, private choose: (id: string) => void) {
    this.id = id;
    root.innerHTML = `
      <button class="g-arrow" data-step="-1" aria-label="previous car">‹</button>
      <div class="g-car" aria-live="polite">
        <small class="g-maker"></small>
        <b class="g-model"></b>
        <p class="g-blurb"></p>
        <div class="g-stats">${STATS.map(([k, label]) => `<span>${label}<i data-stat="${k}"></i></span>`).join('')}</div>
        <div class="g-dots">${CARS.map(() => '<i></i>').join('')}</div>
      </div>
      <button class="g-arrow" data-step="1" aria-label="next car">›</button>`;
    this.maker = root.querySelector('.g-maker')!;
    this.model = root.querySelector('.g-model')!;
    this.blurb = root.querySelector('.g-blurb')!;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-stat]'))) this.bars[el.dataset.stat!] = el;
    this.dots = Array.from(root.querySelectorAll<HTMLElement>('.g-dots i'));
    for (const b of Array.from(root.querySelectorAll<HTMLElement>('.g-arrow'))) {
      b.addEventListener('click', () => this.step(Number(b.dataset.step)));
    }
    root.classList.toggle('single', CARS.length < 2);
    this.show(id);
  }

  /** Next or previous car, wrapping round. */
  step(dir: number) {
    const i = CARS.findIndex((c) => c.id === this.id);
    this.choose(CARS[(i + dir + CARS.length) % CARS.length].id);
  }

  show(id: string) {
    this.id = id;
    const c = carInfo(id);
    this.maker.textContent = c.maker;
    this.model.textContent = c.model;
    this.blurb.textContent = c.blurb;
    for (const [k] of STATS) this.bars[k].style.setProperty('--v', String(c.stats[k] / 5));
    this.dots.forEach((d, i) => d.classList.toggle('on', CARS[i].id === id));
  }
}
