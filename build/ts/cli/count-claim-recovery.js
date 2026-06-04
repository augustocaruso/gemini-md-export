const recoverableCountClaimPattern = /claim-tab|tab_claim_visual_failed|command_timeout|command_channel_unready|command_unready|Timeout aguardando resposta/i;
export const isRecoverableCountClaimError = (err) => {
    const text = [err?.message, err?.code, err?.data?.code, err?.data?.error]
        .filter(Boolean)
        .join(' ');
    return recoverableCountClaimPattern.test(text);
};
export const countClaimWarningMessage = (err) => `Indicador visual da aba nao respondeu; continuando a contagem sem ele. (${err?.message || err})`;
