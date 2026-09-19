// SDK streamInput eagerly consumes its iterable; only a committed/failed result
// may release the next browser delivery.
export class SequentialTurnGate {
  begin() {
    if (this.release) throw new Error("Previous Claude turn has not settled.");
    this.pending = new Promise((resolve) => { this.release = resolve; });
  }
  wait() { return this.pending; }
  finish() {
    this.release?.();
    this.release = null;
  }
}
