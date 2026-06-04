export const runFixVaultSmokeCommand = async ({ parsed, streams = {}, dependencies, }) => {
    const stdout = streams.stdout || process.stdout;
    const doctorParsed = {
        ...parsed,
        positionals: ['doctor', ...parsed.positionals.slice(1)],
    };
    const doctor = await dependencies.runDoctor(doctorParsed, streams);
    if (doctor.exitCode !== 0) {
        const result = {
            ok: false,
            action: 'fix_vault_smoke',
            doctor: doctor.result,
            fixVault: null,
            nextAction: doctor.result?.nextAction || {
                code: 'fix_vault_doctor_failed',
                message: 'Corrija o doctor antes de rodar fix-vault.',
            },
        };
        if (parsed.flags.format !== 'json')
            stdout.write('Smoke: bloqueado no doctor.\n');
        return { exitCode: doctor.exitCode, result };
    }
    const fixVaultParsed = {
        ...parsed,
        positionals: parsed.positionals.slice(1),
    };
    const fixVault = await dependencies.runFixVault(fixVaultParsed, streams);
    const result = {
        ok: fixVault.exitCode === 0,
        action: 'fix_vault_smoke',
        doctor: doctor.result,
        fixVault: fixVault.result,
    };
    if (parsed.flags.format !== 'json')
        stdout.write(`Smoke: ${result.ok ? 'concluido' : 'falhou'}.\n`);
    return { exitCode: fixVault.exitCode, result };
};
