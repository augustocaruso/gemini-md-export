import { assertClaimableGeminiTab, explainGeminiClientLifecycleRejection, getClaimableGeminiTabs, toClaimableGeminiTab, } from './client-lifecycle.js';
export const explainActiveClaimableGeminiClientRejection = explainGeminiClientLifecycleRejection;
export const toActiveClaimableGeminiClient = toClaimableGeminiTab;
export const toRecentExportClaimableGeminiClient = (client, options) => toClaimableGeminiTab(client, { ...options, capability: 'recent-export' });
export const assertActiveClaimableGeminiClient = assertClaimableGeminiTab;
export const getActiveClaimableGeminiClients = getClaimableGeminiTabs;
