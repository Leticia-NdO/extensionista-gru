import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

let cachedApiKeyPromise: Promise<string> | null = null;

function extractKeyFromSecretString(secretString: string): string {
	const trimmed = (secretString ?? '').trim();
	if (!trimmed) return '';

	// Support either a raw API key string or a JSON object containing it.
	if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
		try {
			const parsed = JSON.parse(trimmed);
			if (typeof parsed === 'string') return parsed;
			if (parsed && typeof parsed === 'object') {
				const candidates = [
					(parsed as any).OPENAI_API_KEY,
					(parsed as any).openai_api_key,
					(parsed as any).apiKey,
					(parsed as any).key,
					(parsed as any).token,
				];
				const found = candidates.find((v) => typeof v === 'string' && v.trim().length > 0);
				if (found) return found.trim();
			}
		} catch {
			// fall through
		}
	}

	return trimmed;
}

export async function getOpenAIApiKey(options?: {
	region?: string;
	secretId?: string;
}): Promise<string> {
	if (process.env.OPENAI_API_KEY?.trim()) {
		return process.env.OPENAI_API_KEY.trim();
	}

	if (!cachedApiKeyPromise) {
		cachedApiKeyPromise = (async () => {
			const region = options?.region || process.env.AWS_REGION || 'us-east-1';
			const secretId = options?.secretId || process.env.OPENAI_SECRET_ID || 'llm/openapi-secret';
			const client = new SecretsManagerClient({ region });
			const resp = await client.send(new GetSecretValueCommand({ SecretId: secretId }));

			let secretString = resp.SecretString;
			if (!secretString && resp.SecretBinary) {
				const binary = Buffer.from(resp.SecretBinary as any);
				secretString = binary.toString('utf8');
			}

			const key = extractKeyFromSecretString(secretString || '');
			if (!key) {
				throw new Error(`Secret ${secretId} is empty or missing an OpenAI API key`);
			}
			return key;
		})();
	}

	return cachedApiKeyPromise;
}

