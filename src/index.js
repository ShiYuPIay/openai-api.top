import coreWorker from "./core/worker.js";
import { createResilientWorker } from "./runtime/resilient-worker.js";

export default createResilientWorker(coreWorker);
