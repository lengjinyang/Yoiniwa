export interface GenerationRequest {
  generation: number;
}

export class WorkerGeneration {
  private value = 1;

  current() { return this.value; }

  advance() {
    this.value += 1;
    return this.value;
  }

  stamp<T extends object>(request: T): T & GenerationRequest {
    return { ...request, generation: this.value };
  }

  accepts(result: GenerationRequest) {
    return result.generation === this.value;
  }
}
