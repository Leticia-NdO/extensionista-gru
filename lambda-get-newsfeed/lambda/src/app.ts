import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { Readable } from 'stream';

const region = process.env.AWS_REGION || 'us-east-1';
const tableName = process.env.DDB_TABLE_NAME || '';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

type ApiResponse = {
	statusCode: number;
	headers: Record<string, string>;
	body: string;
};

function json(statusCode: number, payload: any): ApiResponse {
	return {
		statusCode,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
		},
		body: JSON.stringify(payload),
	};
}

function badRequest(message: string): ApiResponse {
	return json(400, { message });
}

function notFound(message: string): ApiResponse {
	return json(404, { message });
}

function parseLimit(input: string | undefined): number {
	const parsed = Number(input);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
	return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function encodeCursor(key: any): string {
	return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): any {
	const raw = Buffer.from(cursor, 'base64url').toString('utf8');
	return JSON.parse(raw);
}

function streamToString(body: any): Promise<string> {
	if (!body) return Promise.resolve('');
	if (typeof body === 'string') return Promise.resolve(body);
	if (Buffer.isBuffer(body)) return Promise.resolve(body.toString('utf8'));
	const readable = body as Readable;
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		readable.on('data', (chunk: any) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		readable.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		readable.on('error', reject);
	});
}

function parseS3Path(s3Path: string): { bucket: string; key: string } | null {
	const trimmed = (s3Path || '').trim();
	if (!trimmed.startsWith('s3://')) return null;
	const withoutScheme = trimmed.slice('s3://'.length);
	const slash = withoutScheme.indexOf('/');
	if (slash <= 0) return null;
	const bucket = withoutScheme.slice(0, slash);
	const key = withoutScheme.slice(slash + 1);
	if (!bucket || !key) return null;
	return { bucket, key };
}

function normalizeMateriaPk(input: string): string | null {
	const pk = (input || '').trim();
	if (!pk) return null;

	// Already in canonical form.
	if (/^MATERIA#\d{8}_\d{3}$/.test(pk)) return pk;

	// Accept space instead of '#': "MATERIA 20260519_001" or "MATERIA 260519_001".
	const spaceMatch = pk.match(/^MATERIA\s+(\d{6}|\d{8})_(\d{3})$/);
	if (spaceMatch) {
		let datePart = spaceMatch[1];
		const seq = spaceMatch[2];
		if (datePart.length === 6) {
			// Interpret as YYMMDD and assume 20YYMMDD.
			datePart = `20${datePart}`;
		}
		return `MATERIA#${datePart}_${seq}`;
	}

	// Accept missing '#' but with MATERIA prefix glued: "MATERIA20260519_001".
	const gluedMatch = pk.match(/^MATERIA(\d{6}|\d{8})_(\d{3})$/);
	if (gluedMatch) {
		let datePart = gluedMatch[1];
		const seq = gluedMatch[2];
		if (datePart.length === 6) {
			datePart = `20${datePart}`;
		}
		return `MATERIA#${datePart}_${seq}`;
	}

	// Accept "MATERIA#260519_001" and expand.
	const shortHashMatch = pk.match(/^MATERIA#(\d{6})_(\d{3})$/);
	if (shortHashMatch) {
		return `MATERIA#20${shortHashMatch[1]}_${shortHashMatch[2]}`;
	}

	return null;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
	marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({ region });

async function listFeed(queryStringParameters: Record<string, string> | undefined): Promise<ApiResponse> {
	if (!tableName.trim()) return json(500, { message: 'DDB_TABLE_NAME não configurada.' });

	const limit = parseLimit(queryStringParameters?.limit);
	const cursor = queryStringParameters?.cursor;
	let exclusiveStartKey: any | undefined;
	if (cursor) {
		try {
			exclusiveStartKey = decodeCursor(cursor);
		} catch {
			return badRequest('Cursor inválido.');
		}
	}

	const resp = await ddb.send(
		new QueryCommand({
			TableName: tableName,
			IndexName: 'GSI1',
			KeyConditionExpression: 'GSI1PK = :pk',
			ExpressionAttributeValues: {
				':pk': 'MATERIA',
			},
			ScanIndexForward: false,
			Limit: limit,
			ExclusiveStartKey: exclusiveStartKey,
		}),
	);

	const items = (resp.Items || []).map((it: any) => ({
		id: it.PK,
		title: it.title,
		briefSummary: it.briefSummary,
		status: it.status,
		publishedAt: it.GSI1SK,
	}));

	const nextCursor = resp.LastEvaluatedKey ? encodeCursor(resp.LastEvaluatedKey) : null;
	return json(200, { items, nextCursor });
}

async function getMateria(pk: string): Promise<ApiResponse> {
	if (!tableName.trim()) return json(500, { message: 'DDB_TABLE_NAME não configurada.' });
	if (!pk?.trim()) return badRequest('PK ausente.');

	const normalizedPk = normalizeMateriaPk(pk);
	if (!normalizedPk) {
		console.warn('PK com formato inesperado:', pk);
		return json(400, {
			message: 'PK com formato inválido.',
			hint: 'Use MATERIA#YYYYMMDD_001 (ou MATERIA YYMMDD_001 / MATERIA YYYYMMDD_001).',
		});
	}

	console.log('Fetching metadata for PK:', normalizedPk);

	const match = normalizedPk.match(/^MATERIA#(\d{4})(\d{2})(\d{2})_\d{3}$/);
	if (!match) {
		console.warn('PK normalizado ainda inválido:', normalizedPk);
		return json(400, { message: 'PK com formato inválido.' });
	}

	const itemsResp = await ddb.send(
		new QueryCommand({
			TableName: tableName,
			KeyConditionExpression: 'PK = :pk',
			ExpressionAttributeValues: {
				':pk': normalizedPk,
			},
		}),
	);

	const items = (itemsResp.Items || []) as any[];
	const meta = items.find((it) => it?.SK === 'METADATA') as any;
	if (!meta) return notFound('Matéria não encontrada.');

	const pollItem = items.find((it) => it?.SK === 'ENQUETE') as any;
	let poll: any = null;
	if (pollItem?.pergunta && Array.isArray(pollItem?.opcoes)) {
		const opcoes = pollItem.opcoes.map((texto: any, idx: number) => ({
			index: idx,
			texto: String(texto ?? ''),
			votos: Number(pollItem[`votos_opcao${idx}`] ?? 0),
		}));
		poll = {
			pergunta: String(pollItem.pergunta),
			opcoes,
			totalVotos: opcoes.reduce((acc: number, it: any) => acc + (Number(it.votos) || 0), 0),
		};
	}

	const parsed = parseS3Path(meta.s3Path);
	if (!parsed) {
		return json(500, { message: 'Metadado s3Path inválido para esta matéria.' });
	}

	const obj = await s3.send(
		new GetObjectCommand({
			Bucket: parsed.bucket,
			Key: parsed.key,
		}),
	);
	const raw = await streamToString(obj.Body);

	let full: any = null;
	try {
		full = JSON.parse(raw);
	} catch {
		full = { raw };
	}

	return json(200, {
		id: meta.PK,
		title: meta.title,
		briefSummary: meta.briefSummary,
		status: meta.status,
		publishedAt: meta.GSI1SK,
		s3Path: meta.s3Path,
		content: full,
		poll,
	});
}

export const handler = async (event: any = {}): Promise<ApiResponse> => {
	try {
		const method = event?.requestContext?.http?.method || event?.httpMethod || 'GET';
		const rawPath = event?.rawPath || event?.path || '/';
		const path = rawPath.split('?')[0];

		if (method === 'GET' && path === '/feed') {
			return await listFeed(event?.queryStringParameters);
		}

        console.log('Evento recebido:', JSON.stringify(path));

		const materiaMatch = method === 'GET' ? path.match(/^\/materias\/(.+)$/) : null;
		if (materiaMatch) {
            console.log('Fetching materia for PK:', JSON.stringify(materiaMatch));
			const pk = decodeURIComponent(materiaMatch[1]);
			return await getMateria(pk);
		}

		return notFound('Rota não encontrada.');
	} catch (err: any) {
		console.error('Erro na API de leitura:', err);
		return json(500, { message: 'Erro interno.' });
	}
};
