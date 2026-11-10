const $ = (id) => document.getElementById(id);

/** Thin wrapper over the DOM overlay. The game pushes values; nothing here reads game state. */
export class Hud {
  constructor() {
    this.el = {
      hud: $('hud'),
      title: $('title'),
      result: $('result'),
      pause: $('pause'),
      banner: $('banner'),
      combo: $('combo'),
      ready: $('ready'),
      timer: $('timer'),
      stage: $('stage-label'),
      enBar: $('p1-en-bar'),
      p2status: $('p2-status'),
      p1name: $('p1-name'),
      p1title: $('p1-title'),
      p2name: $('p2-name'),
      p2title: $('p2-title'),
    };
    this.bars = {
      p1hp: $('p1-hp'),
      p1ghost: $('p1-ghost'),
      p2hp: $('p2-hp'),
      p2ghost: $('p2-ghost'),
      p1en: $('p1-en'),
      p1gd: $('p1-gd'),
      p1st: $('p1-st'),
      p2st: $('p2-st'),
    };
    this.cache = {};
    this.bannerT = 0;
    this.onStart = null;
    this.onResult = null;
    $('start').addEventListener('click', () => this.onStart?.());
    $('result-btn').addEventListener('click', () => this.onResult?.());
  }

  /** Title screen: the start button stays locked until every monster model has arrived. */
  loading(done, total) {
    const btn = $('start');
    btn.disabled = done < total;
    btn.textContent = done < total ? `怪兽接近中… ${done} / ${total}` : '按 Enter 开始战斗';
  }

  show(name, on) {
    this.el[name].classList.toggle('hidden', !on);
  }

  /** Set a bar's fill ratio; skips the DOM write when the value did not change. */
  bar(name, ratio) {
    const v = Math.max(0, Math.min(1, ratio));
    const key = Math.round(v * 500);
    if (this.cache[name] === key) return;
    this.cache[name] = key;
    this.bars[name].style.transform = `scaleX(${v})`;
  }

  text(name, value) {
    if (this.cache[name] === value) return;
    this.cache[name] = value;
    this.el[name].textContent = value;
  }

  flag(name, cls, on) {
    const key = name + ':' + cls;
    if (this.cache[key] === on) return;
    this.cache[key] = on;
    this.el[name].classList.toggle(cls, on);
  }

  /** `hero` and `kaiju` are fighter defs ({ name, title }). */
  setNames(stageIndex, total, hero, kaiju) {
    this.text('p1name', hero.name);
    this.text('p1title', hero.title);
    this.text('p2name', kaiju.name);
    this.text('p2title', kaiju.title);
    this.text('stage', `STAGE ${stageIndex + 1} / ${total}`);
    this.text('p2status', '');
  }

  hp(side, ratio) {
    this.bar(side + 'hp', ratio);
    this.bar(side + 'ghost', ratio);
    const fill = this.bars[side + 'hp'].parentElement;
    const low = ratio < 0.25;
    if (this.cache[side + 'low'] !== low) {
      this.cache[side + 'low'] = low;
      fill.classList.toggle('low', low);
    }
  }

  combo(n) {
    if (this.cache.combo === n) return;
    this.cache.combo = n;
    const el = this.el.combo;
    if (n < 2) {
      el.classList.add('hidden');
      return;
    }
    el.firstElementChild.textContent = n;
    el.classList.remove('hidden');
    el.style.animation = 'none';
    void el.offsetWidth; // restart the pop animation
    el.style.animation = '';
  }

  banner(main, sub = '', dur = 1.4, small = false) {
    const el = this.el.banner;
    el.querySelector('.main').textContent = main;
    el.querySelector('.sub').textContent = sub;
    el.classList.toggle('small', small);
    el.classList.remove('hidden');
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    this.bannerT = dur;
  }

  result(title, sub, stats, button) {
    $('result-title').textContent = title;
    $('result-sub').textContent = sub;
    const box = $('result-stats');
    box.replaceChildren();
    for (const [label, value] of stats) {
      const a = document.createElement('span');
      a.textContent = label;
      const b = document.createElement('b');
      b.textContent = value;
      box.append(a, b);
    }
    $('result-btn').textContent = button;
    this.show('result', true);
  }

  update(dt) {
    if (this.bannerT > 0) {
      this.bannerT -= dt;
      if (this.bannerT <= 0) this.el.banner.classList.add('hidden');
    }
  }
}
