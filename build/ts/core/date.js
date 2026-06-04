export const portableIsoSeconds = (value) => {
    if (!value)
        return null;
    const date = value instanceof Date
        ? value
        : typeof value === 'number'
            ? new Date(value)
            : new Date(String(value));
    if (Number.isNaN(date.getTime()))
        return null;
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
};
