# Signalsmith Stretch Web

Signalsmith Stretch ships as a WASM AudioWorklet module with TypeScript bindings. The published package exposes both CommonJS (`SignalsmithStretch.js`) and ESM (`SignalsmithStretch.mjs`) bundles plus type declarations (`SignalsmithStretch.d.ts`).

## Usage

```ts
import SignalsmithStretch, {
	StretchNode,
	StretchSchedule,
	StretchConfigureOptions
} from 'signalsmith-stretch';

const context = new AudioContext();
const stretch: StretchNode = await SignalsmithStretch(context, {
	outputChannelCount: [2]
});
stretch.connect(context.destination);

await stretch.setUpdateInterval(0.05, (timeSeconds) => console.log('input time', timeSeconds));
await stretch.start();
```

### Scheduling

`stretch.schedule(schedule)` queues automation describing input position, playback rate and pitch. Important fields on `StretchSchedule`:

- `output`: AudioContext time for the change (seconds)
- `input`: playback position inside the buffered material (seconds)
- `rate`: playback speed multiplier (1 == real time)
- `semitones`, `tonalityHz`, `formantSemitones`, `formantCompensation`, `formantBaseHz`: pitch/formant controls
- `loopStart` / `loopEnd`: optional loop region
- `active`: toggle processing on/off

`stretch.start()`/`stretch.stop()` wrap `schedule` with an AudioBufferSourceNode-like signature: `start(when?, offset?, duration?, rate?, semitones?)`.

### Feeding audio buffers

`stretch.addBuffers(buffers, transferList?)` appends audio data. `buffers` is an array of `Float32Array`s (one per channel). Pass the underlying `ArrayBuffer`s via the optional transfer list to avoid copying.

`stretch.dropBuffers()` clears all buffered audio. Providing a number drops buffers that finish before the given time and resolves with `{start, end}` describing the remaining buffered range.

### Monitoring + latency

- `stretch.inputTime` reports the last known playback position. Call `stretch.setUpdateInterval(seconds, callback)` to control how often the node posts updates back to the main thread.
- `stretch.latency()` resolves to the sum of input/output latency in seconds. For click-free automation, schedule changes slightly ahead of real time by that amount.

### Reconfiguration

`stretch.configure(config)` accepts either presets (`preset: 'default' | 'cheaper'`) or explicit STFT sizes via `blockMs`, `intervalMs`, and `splitComputation`.

## TypeScript

The package exports the `StretchNode`, `StretchSchedule`, `StretchConfigureOptions`, `StretchBufferRange`, and `StretchBufferBlock` types alongside the default factory. Everything is fully typed for both browser and bundler workflows.

## Building locally

```
cd web
npm install
npm run build
make release/SignalsmithStretch.mjs
```

`npm run build` transpiles the TypeScript bindings into `web/dist/`; the `Makefile` concatenates them with the generated WASM glue and produces both `.js` and `.mjs` builds in `web/release/`.
