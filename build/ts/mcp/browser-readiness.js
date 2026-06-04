import { clientHasPageBlocker, clientPageBlockerCode } from './bridge-health.js';
export const evaluateBrowserReadiness = ({ allLiveClients = [], selectableClients = [], matchingClients = [], commandReadyClients = [], claimableClients = [], } = {}) => {
    const ready = claimableClients.length > 0;
    let blockingIssue = null;
    if (!ready) {
        const blockedClient = allLiveClients.find(clientHasPageBlocker);
        if (allLiveClients.length === 0) {
            blockingIssue = 'no_connected_clients';
        }
        else if (blockedClient) {
            blockingIssue = clientPageBlockerCode(blockedClient) || 'google_page_blocked';
        }
        else if (matchingClients.length === 0) {
            blockingIssue = 'extension_version_mismatch';
        }
        else if (commandReadyClients.length === 0) {
            blockingIssue = 'command_channel_not_ready';
        }
        else if (selectableClients.length === 0) {
            blockingIssue = 'no_selectable_gemini_tab';
        }
        else {
            blockingIssue = 'no_active_claimable_gemini_tab';
        }
    }
    return {
        ready,
        blockingIssue,
        connectedClientCount: allLiveClients.length,
        selectableTabCount: selectableClients.length,
        claimableTabCount: claimableClients.length,
        matchingClientCount: matchingClients.length,
        commandReadyClientCount: commandReadyClients.length,
    };
};
