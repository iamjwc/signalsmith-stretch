export interface StretchSchedule {
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

export interface StretchConfigureOptions {
	blockMs?: number;
	intervalMs?: number;
	splitComputation?: boolean;
	preset?: 'default' | 'cheaper';
}

export interface StretchBufferRange {
	start: number;
	end: number;
}

export type StretchBufferBlock = Float32Array[];

export interface StretchNode extends AudioWorkletNode {
	/**
	 * Current playback position within the buffered audio, updated via `setUpdateInterval()`.
	 */
	inputTime: number;
	configure(config: StretchConfigureOptions): Promise<void>;
	latency(): Promise<number>;
	setUpdateInterval(seconds: number, callback?: (timeSeconds: number) => void): Promise<void>;
	start(when?: number | StretchSchedule, offset?: number, duration?: number, rate?: number, semitones?: number): Promise<StretchSchedule>;
	stop(when?: number): Promise<StretchSchedule>;
	schedule(schedule: StretchSchedule, adjustPrevious?: boolean): Promise<StretchSchedule>;
	addBuffers(sampleBuffers: StretchBufferBlock, transfer?: Transferable[]): Promise<number>;
	dropBuffers(): Promise<StretchBufferRange>;
	dropBuffers(toSeconds: number): Promise<StretchBufferRange>;
}

export type SignalsmithStretchEntryPoint = (
	audioContext: BaseAudioContext,
	options?: AudioWorkletNodeOptions
) => Promise<StretchNode>;

declare const SignalsmithStretch: SignalsmithStretchEntryPoint;

export default SignalsmithStretch;
