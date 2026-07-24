/**
 * Development-only server capabilities.
 *
 * These capabilities are derived exclusively on the server: clients cannot
 * enable them through request data, URL flags, or local storage. God Mode is
 * enabled by default outside explicit production runs and can be disabled with
 * `DD_GOD_MODE=false`.
 */

import {
  ENFORCE_LOGISTICS_POLICY,
  GOD_MODE_LOGISTICS_POLICY,
  type LogisticsIntentPolicy,
} from './logistics/context.js';
import type { MatchCapabilities } from '../shared/matchTypes.js';

/**
 * Return the logistics policy for this server process.
 *
 * Production always uses normal costs and requires real engineers. Development
 * God Mode waives Refined_Product costs and can queue bridge/forest tasks with
 * no unit, while retaining all terrain and duplicate-placement validation.
 */
export function getDevelopmentLogisticsPolicy(
  env: NodeJS.ProcessEnv = process.env,
): LogisticsIntentPolicy {
  return env.NODE_ENV === 'production' || env.DD_GOD_MODE === 'false'
    ? ENFORCE_LOGISTICS_POLICY
    : GOD_MODE_LOGISTICS_POLICY;
}

/**
 * Expose the active server policy to an established client without accepting
 * any client-controlled capability flag.
 */
export function getDevelopmentMatchCapabilities(
  env: NodeJS.ProcessEnv = process.env,
): MatchCapabilities {
  const policy = getDevelopmentLogisticsPolicy(env);
  return {
    remoteTerrainTasks: policy.allowRemoteTerrainTasks,
    waiveConstructionCosts: policy.waiveRefinedProductCosts,
    standaloneRoadConstruction: policy.allowRemoteTerrainTasks && policy.waiveRefinedProductCosts,
    entityEditing: policy.allowRemoteTerrainTasks && policy.waiveRefinedProductCosts,
  };
}
