// Runs the 0.x-era suites against 1.0.0 in mode "service" (the opt-in path to 402xAgent).
import * as M from "../index.js";
export * from "../index.js";
const S = (o = {}) => ({ mode: "service", ...o });
export const spotCheckFetch = (f, o) => M.spotCheckFetch(f, S(o));
export const spotCheckAxios = (i, o) => M.spotCheckAxios(i, S(o));
export const checkBeforePay = (u, o) => M.checkBeforePay(u, S(o));
export const createSpotChecker = (o) => M.createSpotChecker(S(o));
