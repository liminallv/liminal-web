import { defineEntity, entityRuntime, LIMINAL_SIGNALS } from '@liminal-lv/core';

import { emitter, label, type Emit } from './kinds.ts';

export const func_counter = defineEntity({
  classname: 'func_counter',
  description:
    'Counts activations on targetname and signals on_complete when it reaches count. Wire ai_spawner.on_kill here to make a kill counter.',
  metadata: {
    color: '#FB923C',
    gizmos: [
      { type: 'billboard', size: '0.5', texture: 'gizmos/counter.png', offset: '0,0,0.8' },
      { type: 'box', size: '0.3', style: 'solid', color: '#FB923C', alpha: '0.3', offset: '0,0,0.3' },
      label('{{targetname}} / {{count}}', '#FB923C'),
    ],
  },
  props: [
    { name: 'targetname', type: 'source', default_value: '', description: 'Each activation of this name counts one.' },
    { name: 'count', type: 'int', default_value: 10, min: 1, max: 200, step: 1, description: 'Activations needed.' },
    { name: 'on_count', type: 'destination', default_value: '', description: 'Activated on every count.' },
    { name: 'on_complete', type: 'destination', default_value: '', description: 'Activated when count is reached.' },
    { name: 'repeat', type: 'bool', default_value: false, description: 'Reset and count again after completing.' },
  ],
});

export class Counter {
  readonly emit: Emit;
  readonly count: number;
  readonly onCount: string;
  readonly onComplete: string;
  readonly repeat: boolean;
  n = 0;
  done = false;

  constructor(emit: Emit, count: number, onCount: string, onComplete: string, repeat: boolean) {
    this.emit = emit;
    this.count = count;
    this.onCount = onCount;
    this.onComplete = onComplete;
    this.repeat = repeat;
  }

  increment(): void {
    if (this.done) return;
    this.n++;
    this.emit(this.onCount, true);
    if (this.n < this.count) return;
    this.emit(this.onComplete, true);
    if (this.repeat) this.n = 0;
    else this.done = true;
  }
}

export const counter = entityRuntime(func_counter, {
  spawn: (placed, self) => {
    const { count, on_count, on_complete, repeat } = placed.properties;
    return new Counter(emitter(self), count, on_count, on_complete, repeat);
  },
  signals: {
    targetname: (counter, message) => {
      if (message.sig === LIMINAL_SIGNALS.ACTIVATE) counter.increment();
    },
  },
});
