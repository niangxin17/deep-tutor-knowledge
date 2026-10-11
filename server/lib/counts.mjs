/**
 * Re-export domainCounts for deep-tutor /studio wiring.
 * Prefer: import { domainCounts, loadWhitelist } from './knowledge.mjs'
 */
export { domainCounts, loadWhitelist, countWikilinks, countMentions } from "./knowledge.mjs";
