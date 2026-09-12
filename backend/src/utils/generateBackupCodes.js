
import crypto from 'crypto';

export function generateBackupCodes(count = 10) {
    const codes = [];
    for (let i = 0; i < count; i++) {
        // Generates a random, secure 8-character string
        const code = crypto.randomBytes(4).toString('hex').toUpperCase();
        codes.push(code);
    }

    return codes;
}
