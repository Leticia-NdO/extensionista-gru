import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const region = process.env.AWS_REGION || 'us-east-1';
const tableName = process.env.DDB_TABLE_NAME || '';

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
			'access-control-allow-origin': '*',
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

function normalizeMateriaPk(input: string): string | null {
	const pk = (input || '').trim();
	if (!pk) return null;

	if (/^MATERIA#\d{8}_\d{3}$/.test(pk)) return pk;

	const spaceMatch = pk.match(/^MATERIA\s+(\d{6}|\d{8})_(\d{3})$/);
	if (spaceMatch) {
		let datePart = spaceMatch[1];
		const seq = spaceMatch[2];
		if (datePart.length === 6) datePart = `20${datePart}`;
		return `MATERIA#${datePart}_${seq}`;
	}

	const gluedMatch = pk.match(/^MATERIA(\d{6}|\d{8})_(\d{3})$/);
	if (gluedMatch) {
		let datePart = gluedMatch[1];
		const seq = gluedMatch[2];
		if (datePart.length === 6) datePart = `20${datePart}`;
		return `MATERIA#${datePart}_${seq}`;
	}

	const shortHashMatch = pk.match(/^MATERIA#(\d{6})_(\d{3})$/);
	if (shortHashMatch) {
		return `MATERIA#20${shortHashMatch[1]}_${shortHashMatch[2]}`;
	}

	return null;
}

function decodeBody(event: any): any {
	const bodyRaw = event?.body;
	if (!bodyRaw) return null;
	const str = event?.isBase64Encoded ? Buffer.from(bodyRaw, 'base64').toString('utf8') : String(bodyRaw);
	try {
		return JSON.parse(str);
	} catch {
		return null;
	}
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
	marshallOptions: { removeUndefinedValues: true },
});

function mapPollFromItem(item: any): any {
	if (!item?.pergunta || !Array.isArray(item?.opcoes)) return null;
	const opcoes = item.opcoes.map((texto: any, idx: number) => ({
		index: idx,
		texto: String(texto ?? ''),
		votos: Number(item[`votos_opcao${idx}`] ?? 0),
	}));
	return {
		pergunta: String(item.pergunta),
		opcoes,
		totalVotos: opcoes.reduce((acc: number, it: any) => acc + (Number(it.votos) || 0), 0),
	};
}

async function vote(pk: string, optionIndex: number): Promise<any> {
	if (!tableName.trim()) throw new Error('DDB_TABLE_NAME não configurada.');

	const attr = `votos_opcao${optionIndex}`;
	const resp = await ddb.send(
		new UpdateCommand({
			TableName: tableName,
			Key: { PK: pk, SK: 'ENQUETE' },
			UpdateExpression: 'ADD #v :inc',
			ConditionExpression: 'attribute_exists(PK) AND attribute_exists(SK) AND attribute_exists(#v)',
			ExpressionAttributeNames: {
				'#v': attr,
			},
			ExpressionAttributeValues: {
				':inc': 1,
			},
			ReturnValues: 'ALL_NEW',
		}),
	);
	return resp.Attributes;
}

export const handler = async (event: any = {}): Promise<ApiResponse> => {
	try {
		const method = event?.requestContext?.http?.method || event?.httpMethod || 'POST';
		const rawPath = event?.rawPath || event?.path || '/';
		const path = rawPath.split('?')[0];

		if (method !== 'POST') {
			return json(405, { message: 'Método não permitido.' });
		}

		const m = path.match(/^\/materias\/(.+)\/voto$/);
		if (!m) return notFound('Rota não encontrada.');

		const pkRaw = decodeURIComponent(m[1]);
		const pk = normalizeMateriaPk(pkRaw);
		if (!pk) return badRequest('PK com formato inválido.');

		const body = decodeBody(event);
		const optionIndex = Number(body?.optionIndex ?? body?.opcao ?? body?.option);
		if (!Number.isFinite(optionIndex) || !Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 20) {
			return badRequest('Opção inválida.');
		}

		try {
			const updated = await vote(pk, optionIndex);
			return json(200, {
				ok: true,
				pk,
				optionIndex,
				poll: mapPollFromItem(updated),
			});
		} catch (err: any) {
			if (err?.name === 'ConditionalCheckFailedException') {
				return badRequest('Enquete não encontrada ou opção inválida.');
			}
			throw err;
		}
	} catch (err: any) {
		console.error('Erro ao processar voto:', err);
		return json(500, { message: 'Erro interno.' });
	}
};
