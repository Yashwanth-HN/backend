/**
 * BaseAgent — abstract foundation for all research pipeline agents.
 * Each agent has a name, a logger, and a run() method to override.
 */
export class BaseAgent {
  constructor(name) {
    this.name = name;
  }

  log(message, data = null) {
    const entry = { agent: this.name, time: new Date().toISOString(), message };
    if (data !== null) entry.data = data;
    console.log(`[${this.name}]`, message, data ?? "");
    return entry;
  }

  /**
   * Override in subclass. Must return { result, logs }.
   * @param {object} input
   * @param {string[]} sharedLogs — append log entries here
   */
  async run(_input, _sharedLogs) {
    throw new Error(`${this.name}.run() must be implemented`);
  }

  /** Wraps run() with uniform error logging. */
  async execute(input, sharedLogs = []) {
    const start = Date.now();
    sharedLogs.push(this.log(`Starting`));
    try {
      const result = await this.run(input, sharedLogs);
      sharedLogs.push(this.log(`Completed in ${Date.now() - start}ms`));
      return result;
    } catch (err) {
      const errEntry = this.log(`Error: ${err.message}`);
      sharedLogs.push(errEntry);
      throw err;
    }
  }
}
