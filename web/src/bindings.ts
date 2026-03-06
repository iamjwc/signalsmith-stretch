/* eslint-disable @typescript-eslint/no-explicit-any */
declare const module: { exports: unknown } | undefined;
declare const exports: Record<string, unknown> | undefined;
declare const define: ((deps: unknown[], factory: () => unknown) => unknown) & { amd?: unknown };
declare const sampleRate: number;
declare const currentTime: number;

interface AudioWorkletProcessorConstructor {
	new (options?: AudioWorkletNodeOptions): AudioWorkletProcessor;
	readonly prototype: AudioWorkletProcessor;
}

declare abstract class AudioWorkletProcessor {
	readonly port: MessagePort;
	constructor(options?: AudioWorkletNodeOptions);
	abstract process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
type WasmPointer = number;

interface StretchWasmModule {
	_main(): void;
	_configure(channels: number, blockSamples: number, intervalSamples: number, splitComputation: boolean): void;
	_presetDefault(channels: number, sampleRate: number): void;
	_presetCheaper(channels: number, sampleRate: number): void;
	_reset(): void;
	_setBuffers(channels: number, bufferLength: number): WasmPointer;
	_inputLatency(): number;
	_outputLatency(): number;
	_setTransposeSemitones(semitones: number, tonalityNormalised: number): void;
	_setFormantSemitones(semitones: number, compensatePitch: boolean): void;
	_setFormantBase(baseNormalised: number): void;
	_seek(bufferLength: number, rate: number): void;
	_process(inputSamples: number, outputSamples: number): void;
	_setTransposeFactor?(factor: number): void;
	exports?: { memory: WebAssembly.Memory };
	HEAP8: Int8Array;
}

type WasmModuleFactory = (moduleArg?: Record<string, unknown>) => Promise<StretchWasmModule>;

interface StretchSchedule {
	active?: boolean;
	input?: number | null;
	output?: number;
	rate?: number;
	semitones?: number;
	tonalityHz?: number;
	formantSemitones?: number;
	formantCompensation?: boolean;
	formantBaseHz?: number;
	loopStart?: number;
	loopEnd?: number;
	outputTime?: number;
}

interface StretchConfigureOptions {
	blockMs?: number;
	intervalMs?: number;
	splitComputation?: boolean;
	preset?: 'default' | 'cheaper';
}

interface StretchBufferRange {
	start: number;
	end: number;
}

type BufferTransfer = {
	value: StretchBufferRange;
	transfer: Transferable[];
};

type BufferArray = Float32Array[];

interface RemoteMethodDefinitions {
	configure(config: StretchConfigureOptions): void;
	latency(): number;
	setUpdateInterval(seconds: number): void;
	stop(when?: number): StretchSchedule;
	start(when?: number | StretchSchedule, offset?: number, duration?: number, rate?: number, semitones?: number): StretchSchedule;
	schedule(schedule: StretchSchedule, adjustPrevious?: boolean): StretchSchedule;
	dropBuffers(toSeconds?: number): BufferTransfer | { value: StretchBufferRange };
	addBuffers(sampleBuffers: BufferArray): number;
}

type RemoteMethodName = keyof RemoteMethodDefinitions;

type RemoteMethodArgCounts = Record<RemoteMethodName, number>;

interface StretchNode extends AudioWorkletNode {
	inputTime: number;
	setUpdateInterval(seconds: number, callback?: (timeSeconds: number) => void): Promise<void>;
	configure(config: StretchConfigureOptions): Promise<void>;
	latency(): Promise<number>;
	stop(when?: number): Promise<StretchSchedule>;
	start(when?: number | StretchSchedule, offset?: number, duration?: number, rate?: number, semitones?: number): Promise<StretchSchedule>;
	schedule(schedule: StretchSchedule, adjustPrevious?: boolean): Promise<StretchSchedule>;
	dropBuffers(): Promise<StretchBufferRange>;
	dropBuffers(toSeconds: number): Promise<StretchBufferRange>;
	addBuffers(sampleBuffers: BufferArray, transfer?: Transferable[]): Promise<number>;
}

declare function registerProcessor(name: string, processorCtor: AudioWorkletProcessorConstructor): void;
declare let SignalsmithStretch: WasmModuleFactory | StretchEntryPoint;

function registerWorkletProcessor(ModuleFactory: WasmModuleFactory, audioNodeKey: string): void {
	class WasmProcessor extends AudioWorkletProcessor {
		private wasmReady = false;
		private wasmModule: StretchWasmModule | null = null;
		private channels = 0;
		private buffersIn: WasmPointer[] = [];
		private buffersOut: WasmPointer[] = [];
		private audioBuffers: BufferArray[] = [];
		private audioBuffersStart = 0;
		private audioBuffersEnd = 0;
		private timeIntervalSamples = sampleRate * 0.1;
		private timeIntervalCounter = 0;
		private bufferLength = 0;
		private inputLatencySeconds = 0;
		private outputLatencySeconds = 0;
		private timeMap: StretchSchedule[] = [
			{
				active: false,
				input: 0,
				output: 0,
				rate: 1,
				semitones: 0,
				tonalityHz: 8000,
				formantSemitones: 0,
				formantCompensation: false,
				formantBaseHz: 0,
				loopStart: 0,
				loopEnd: 0
			}
		];
		private config: StretchConfigureOptions = { preset: 'default' };
		private pendingMessages: MessageEvent[] = [];

		constructor(options: AudioWorkletNodeOptions = {}) {
			super(options);

			this.port.onmessage = (event: MessageEvent) => this.pendingMessages.push(event);
			ModuleFactory().then(wasmModule => {
				this.wasmModule = wasmModule;
				this.wasmReady = true;
				wasmModule._main();

				this.channels = options.numberOfOutputs ? options.outputChannelCount?.[0] ?? 2 : 2;
				this.configure();

				const remoteMethods: RemoteMethodDefinitions = {
					configure: config => {
						Object.assign(this.config, config);
						this.configure();
					},
					latency: () => this.inputLatencySeconds + this.outputLatencySeconds,
					setUpdateInterval: seconds => {
						this.timeIntervalSamples = sampleRate * seconds;
					},
					stop: when => {
						const stopTime = typeof when === 'number' ? when : currentTime;
						return remoteMethods.schedule({ active: false, output: stopTime });
					},
					start: (when, offset, duration, rate, semitones) => {
						if (typeof when === 'object') {
							const schedule = when as StretchSchedule;
							if (!('active' in schedule)) schedule.active = true;
							return remoteMethods.schedule(schedule);
						}
						const obj: StretchSchedule = {
							active: true,
							input: 0,
							output: currentTime + this.outputLatencySeconds
						};
						if (typeof when === 'number') obj.output = when;
						if (typeof offset === 'number') obj.input = offset;
						if (typeof rate === 'number') obj.rate = rate;
						if (typeof semitones === 'number') obj.semitones = semitones;
						const result = remoteMethods.schedule(obj);
						if (typeof duration === 'number') {
							remoteMethods.stop((obj.output ?? 0) + duration);
							if (obj.output !== undefined) {
								obj.output += duration;
							}
							obj.active = false;
							remoteMethods.schedule(obj);
						}
						return result;
					},
					schedule: (objIn: StretchSchedule, adjustPrevious) => {
						const outputTime = 'outputTime' in objIn ? objIn.outputTime! : currentTime;
						let latestSegment = this.timeMap[this.timeMap.length - 1];
						while (this.timeMap.length && (this.timeMap[this.timeMap.length - 1].output ?? 0) >= outputTime) {
							latestSegment = this.timeMap.pop()!;
						}

						const obj: StretchSchedule = {
							active: latestSegment.active,
							input: null,
							output: outputTime,
							rate: latestSegment.rate,
							semitones: latestSegment.semitones,
							loopStart: latestSegment.loopStart,
							loopEnd: latestSegment.loopEnd
						};
						Object.assign(obj, objIn);
						if (obj.input === null) {
							const rate = latestSegment.active ? (latestSegment.rate ?? 0) : 0;
							obj.input = (latestSegment.input ?? 0) + ((obj.output ?? 0) - (latestSegment.output ?? 0)) * rate;
						}
						this.timeMap.push(obj);

						if (adjustPrevious && this.timeMap.length > 1) {
							const previous = this.timeMap[this.timeMap.length - 2];
							if ((previous.output ?? 0) < currentTime) {
								const rate = previous.active ? (previous.rate ?? 0) : 0;
								previous.input = (previous.input ?? 0) + (currentTime - (previous.output ?? 0)) * rate;
								previous.output = currentTime;
							}
							if ((obj.output ?? 0) !== (previous.output ?? 0)) {
								previous.rate = ((obj.input ?? 0) - (previous.input ?? 0)) / ((obj.output ?? 0) - (previous.output ?? 0));
							}
						}

						let currentMapSegment = this.timeMap[0];
						while (this.timeMap.length > 1 && (this.timeMap[1].output ?? 0) <= outputTime) {
							this.timeMap.shift();
							currentMapSegment = this.timeMap[0];
						}
						const rate = currentMapSegment.active ? (currentMapSegment.rate ?? 0) : 0;
						const inputTime = (currentMapSegment.input ?? 0) + (outputTime - (currentMapSegment.output ?? 0)) * rate;
						this.timeIntervalCounter = this.timeIntervalSamples;
						this.port.postMessage(['time', inputTime]);

						return obj;
					},
					dropBuffers: toSeconds => {
					if (typeof toSeconds !== 'number') {
						const buffers = this.audioBuffers.flat(1).map(buffer => buffer.buffer as ArrayBuffer);
						this.audioBuffers = [];
						this.audioBuffersStart = this.audioBuffersEnd = 0;
						return {
							value: { start: 0, end: 0 },
							transfer: buffers
						};
						}
						const transfer: ArrayBuffer[] = [];
						while (this.audioBuffers.length) {
							const first = this.audioBuffers[0];
							const length = first[0].length;
							const endSamples = this.audioBuffersStart + length;
							const endSeconds = endSamples / sampleRate;
							if (endSeconds > toSeconds) break;

							this.audioBuffers.shift()!.forEach(buffer => transfer.push(buffer.buffer as ArrayBuffer));
							this.audioBuffersStart += length;
						}
						return {
							value: {
								start: this.audioBuffersStart / sampleRate,
								end: this.audioBuffersEnd / sampleRate
							},
							transfer
						};
					},
					addBuffers: sampleBuffers => {
						const bufferSet = ([] as Float32Array[]).concat(sampleBuffers as any) as BufferArray;
						this.audioBuffers.push(bufferSet);
						const length = bufferSet[0]?.length ?? 0;
						this.audioBuffersEnd += length;
						return this.audioBuffersEnd / sampleRate;
					}
				};

				const pendingMessages = this.pendingMessages;
				this.port.onmessage = (event: MessageEvent) => {
					const data = event.data as unknown[];
					const messageId = data.shift() as number | string;
					const methodName = data.shift() as RemoteMethodName;
					const args = data as any[];
					const method = remoteMethods[methodName] as (...methodArgs: any[]) => any;
					const result = method(...args);
					if ((result as BufferTransfer)?.transfer) {
						const transferResult = result as BufferTransfer;
						this.port.postMessage([messageId, transferResult.value], transferResult.transfer);
					} else {
						this.port.postMessage([messageId, result]);
					}
				};

				const methodArgCounts = Object.keys(remoteMethods).reduce((map, key) => {
					const typedKey = key as RemoteMethodName;
					map[typedKey] = remoteMethods[typedKey].length as number;
					return map;
				}, {} as RemoteMethodArgCounts);
				this.port.postMessage(['ready', methodArgCounts]);
				pendingMessages.forEach(message => this.port.onmessage!(message));
				this.pendingMessages = [];
			});
		}

		private configure(): void {
			const wasmModule = this.wasmModule;
			if (!wasmModule) return;
			if (this.config.blockMs) {
				const blockSamples = Math.round((this.config.blockMs / 1000) * sampleRate);
				const intervalSamples = Math.round(((this.config.intervalMs ?? (this.config.blockMs * 0.25)) / 1000) * sampleRate);
				const splitComputation = Boolean(this.config.splitComputation);
				wasmModule._configure(this.channels, blockSamples, intervalSamples, splitComputation);
				wasmModule._reset();
			} else if (this.config.preset === 'cheaper') {
				wasmModule._presetCheaper(this.channels, sampleRate);
			} else {
				wasmModule._presetDefault(this.channels, sampleRate);
			}
			this.updateBuffers();
			this.inputLatencySeconds = wasmModule._inputLatency() / sampleRate;
			this.outputLatencySeconds = wasmModule._outputLatency() / sampleRate;
		}

		private updateBuffers(): void {
			const wasmModule = this.wasmModule;
			if (!wasmModule) return;
			this.bufferLength = wasmModule._inputLatency() + wasmModule._outputLatency();
			const lengthBytes = this.bufferLength * 4;
			const bufferPointer = wasmModule._setBuffers(this.channels, this.bufferLength);
			this.buffersIn = [];
			this.buffersOut = [];
			for (let c = 0; c < this.channels; ++c) {
				this.buffersIn.push(bufferPointer + lengthBytes * c);
				this.buffersOut.push(bufferPointer + lengthBytes * (c + this.channels));
			}
		}

		process(inputList: Float32Array[][], outputList: Float32Array[][]): boolean {
			if (!this.wasmReady || !this.wasmModule) {
				outputList.forEach(output => {
					output.forEach(channel => channel.fill(0));
				});
				return true;
			}
			if (!outputList[0]?.length) return false;

			let outputTime = currentTime + this.outputLatencySeconds;
			while (this.timeMap.length > 1 && (this.timeMap[1].output ?? 0) <= outputTime) {
				this.timeMap.shift();
			}
			const currentMapSegment = this.timeMap[0];
			const wasmModule = this.wasmModule;
			wasmModule._setTransposeSemitones(currentMapSegment.semitones ?? 0, (currentMapSegment.tonalityHz ?? 0) / sampleRate);
			wasmModule._setFormantSemitones(currentMapSegment.formantSemitones ?? 0, Boolean(currentMapSegment.formantCompensation));
			wasmModule._setFormantBase((currentMapSegment.formantBaseHz ?? 0) / sampleRate);

			if ((outputList[0].length ?? 0) !== this.channels) {
				this.channels = outputList[0]?.length ?? 0;
				this.configure();
			}
			const outputBlockSize = outputList[0][0].length;
			let memory = wasmModule.exports ? wasmModule.exports.memory.buffer : wasmModule.HEAP8.buffer;
			const inputs = inputList[0];
			if (!currentMapSegment.active) {
				outputList[0].forEach((_, c) => {
					const buffer = new Float32Array(memory, this.buffersIn[c], outputBlockSize);
					buffer.fill(0);
				});
				wasmModule._process(outputBlockSize, outputBlockSize);
			} else if (inputs?.length) {
				outputList[0].forEach((_, c) => {
					const channelBuffer = inputs[c % inputs.length];
					const buffer = new Float32Array(memory, this.buffersIn[c], outputBlockSize);
					if (channelBuffer) {
						buffer.set(channelBuffer);
					} else {
						buffer.fill(0);
					}
				});
				wasmModule._process(outputBlockSize, outputBlockSize);
			} else {
				let inputTime = (currentMapSegment.input ?? 0) + (outputTime - (currentMapSegment.output ?? 0)) * (currentMapSegment.rate ?? 0);
				const loopLength = (currentMapSegment.loopEnd ?? 0) - (currentMapSegment.loopStart ?? 0);
				if (loopLength > 0 && inputTime >= (currentMapSegment.loopEnd ?? 0)) {
					currentMapSegment.input = (currentMapSegment.input ?? 0) - loopLength;
					inputTime -= loopLength;
				}
				inputTime += this.inputLatencySeconds;
				const inputSamplesEnd = Math.round(inputTime * sampleRate);
				const buffers = outputList[0].map((_, c) => new Float32Array(memory, this.buffersIn[c], this.bufferLength));
				let blockSamples = 0;
				let audioBufferIndex = 0;
				let audioSamples = this.audioBuffersStart;
				let inputSamples = inputSamplesEnd - this.bufferLength;
				if (inputSamples < audioSamples) {
					blockSamples = audioSamples - inputSamples;
					buffers.forEach(buffer => buffer.fill(0, 0, blockSamples));
					inputSamples = audioSamples;
				}
				while (audioBufferIndex < this.audioBuffers.length && audioSamples < inputSamplesEnd) {
					const audioBuffer = this.audioBuffers[audioBufferIndex];
					const startIndex = inputSamples - audioSamples;
					const bufferEnd = audioSamples + audioBuffer[0].length;
					const count = Math.min(audioBuffer[0].length - startIndex, inputSamplesEnd - inputSamples);
					if (count > 0) {
						buffers.forEach((buffer, c) => {
							const channelBuffer = audioBuffer[c % audioBuffer.length];
							buffer.subarray(blockSamples).set(channelBuffer.subarray(startIndex, startIndex + count));
						});
						audioSamples += count;
						blockSamples += count;
					} else {
						audioSamples += audioBuffer[0].length;
					}
					++audioBufferIndex;
				}
				if (blockSamples < this.bufferLength) {
					buffers.forEach(buffer => buffer.subarray(blockSamples).fill(0));
				}
				wasmModule._seek(this.bufferLength, currentMapSegment.rate ?? 0);
				wasmModule._process(0, outputBlockSize);
				this.timeIntervalCounter -= outputBlockSize;
				if (this.timeIntervalCounter <= 0) {
					this.timeIntervalCounter = this.timeIntervalSamples;
					this.port.postMessage(['time', inputTime]);
				}
			}
			memory = wasmModule.exports ? wasmModule.exports.memory.buffer : wasmModule.HEAP8.buffer;
			outputList[0].forEach((channelBuffer, c) => {
				const buffer = new Float32Array(memory, this.buffersOut[c], outputBlockSize);
				channelBuffer.set(buffer);
			});
			return true;
		}
	}

	registerProcessor(audioNodeKey, WasmProcessor);
}

type StretchEntryPoint = ((audioContext: BaseAudioContext, options?: AudioWorkletNodeOptions) => Promise<StretchNode>) & {
	moduleUrl?: string;
};

function createStretchBinding(ModuleFactory: WasmModuleFactory, audioNodeKey = 'signalsmith-stretch'): StretchEntryPoint | Record<string, never> {
	if (typeof AudioWorkletProcessor === 'function' && typeof registerProcessor === 'function') {
		registerWorkletProcessor(ModuleFactory, audioNodeKey);
		return {};
	}
	const promiseKey = Symbol('SignalsmithStretchModule');
	const createNode: StretchEntryPoint = async (audioContext: BaseAudioContext, options?: AudioWorkletNodeOptions) => {
		let audioNode: StretchNode;
		const nodeOptions: AudioWorkletNodeOptions = options ?? {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [2]
		};
		try {
			audioNode = new AudioWorkletNode(audioContext, audioNodeKey, nodeOptions) as StretchNode;
		} catch (error) {
			const ctx = audioContext as AudioContext;
			if (!(ctx as any)[promiseKey]) {
				let moduleUrl = createNode.moduleUrl;
				if (!moduleUrl) {
					const moduleCode = `(${registerWorkletProcessor})((_scriptName=>${ModuleFactory})(),${JSON.stringify(audioNodeKey)})`;
					moduleUrl = URL.createObjectURL(new Blob([moduleCode], { type: 'text/javascript' }));
					createNode.moduleUrl = moduleUrl;
				}
				(ctx as any)[promiseKey] = ctx.audioWorklet.addModule(moduleUrl);
			}
			await (ctx as any)[promiseKey];
			audioNode = new AudioWorkletNode(audioContext, audioNodeKey, nodeOptions) as StretchNode;
		}

		const requestMap: Record<number | string, (value: any) => void> = {};
		let idCounter = 0;
		let timeUpdateCallback: ((timeSeconds: number) => void) | null = null;
		const post = (transfer: Transferable[] | null, ...data: any[]): Promise<any> => {
			const id = idCounter++;
			return new Promise(resolve => {
				requestMap[id] = resolve;
				if (transfer && transfer.length) {
					audioNode.port.postMessage([id, ...data], transfer);
				} else {
					audioNode.port.postMessage([id, ...data]);
				}
			});
		};
		audioNode.inputTime = 0;
		audioNode.port.onmessage = (event: MessageEvent) => {
			const data = event.data as [number | string, any];
			const [id, value] = data;
			if (id === 'time') {
				audioNode.inputTime = value;
				if (timeUpdateCallback) timeUpdateCallback(value);
			}
			if (id in requestMap) {
				requestMap[id](value);
				delete requestMap[id];
			}
		};

		return new Promise(resolve => {
			requestMap['ready'] = (remoteMethodKeys: RemoteMethodArgCounts) => {
				Object.keys(remoteMethodKeys).forEach(key => {
					const argCount = remoteMethodKeys[key as RemoteMethodName];
					(audioNode as any)[key] = (...args: any[]) => {
						let transfer: Transferable[] | null = null;
						if (args.length > argCount) {
							transfer = args.pop();
						}
						return post(transfer, key, ...args);
					};
				});
				audioNode.setUpdateInterval = (seconds: number, callback?: (timeSeconds: number) => void) => {
					timeUpdateCallback = callback ?? null;
					return post(null, 'setUpdateInterval', seconds);
				};
				resolve(audioNode);
			};
		});
	};
	return createNode;
}

const stretchEntry = createStretchBinding(SignalsmithStretch as WasmModuleFactory, 'signalsmith-stretch');
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - reassign the global factory exported by the WASM bundle
SignalsmithStretch = stretchEntry as StretchEntryPoint;
if (typeof exports === 'object' && typeof module === 'object' && module) {
	module.exports = stretchEntry;
} else if (typeof define === 'function' && (define as any).amd) {
	define([], () => stretchEntry);
}
