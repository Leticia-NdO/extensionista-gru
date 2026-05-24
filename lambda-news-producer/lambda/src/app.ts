import OpenAI from 'openai';
import dotenv from 'dotenv';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { Readable } from 'stream';
import { getOpenAIApiKey } from './secret';

// Useful for local runs; in AWS Lambda, env vars already exist.
dotenv.config();

const EXPECTED_BUCKET = process.env.S3_BUCKET_NAME || 'extensionista-gru-1';
const region = process.env.AWS_REGION || 'us-east-1';
const openAIModel = process.env.OPENAI_MODEL || 'gpt-5.5';
const metadataTableName = process.env.DDB_TABLE_NAME || '';

const PollFormat = z.object({
    pergunta: z.string(),
    opcoes: z.array(z.string()).min(2).max(5),
});

type Poll = z.infer<typeof PollFormat>;

const NewsFormat = z.object({
    title: z.string(),
    date: z.string(),
    content: z.string(),
    briefSummary: z.string(),
    enquete: PollFormat,
});

type News = z.infer<typeof NewsFormat>;

function ddmmyyyyToYyyymmdd(dateCompact: string): string | null {
    // dateCompact from watcher is DDMMYYYY
    const match = dateCompact.match(/^(\d{2})(\d{2})(\d{4})$/);
    if (!match) return null;
    const [, dd, mm, yyyy] = match;
    return `${yyyy}${mm}${dd}`;
}

async function putNewsMetadata(options: {
    tableName: string;
    region: string;
    bucket: string;
    s3Key: string;
    title?: string;
    briefSummary?: string;
    status?: string;
    yyyymmdd: string;
    enquete?: Poll;
}): Promise<{ pk: string } | null> {
    const { tableName, region, bucket, s3Key, title, briefSummary, status, yyyymmdd, enquete } = options;
    if (!tableName.trim()) {
        console.warn('DDB_TABLE_NAME não configurada; pulando persistência de metadados no DynamoDB.');
        return null;
    }

    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
        marshallOptions: { removeUndefinedValues: true },
    });

    const gsi1pk = 'MATERIA';
    const gsi1sk = new Date().toISOString();
    const metadataItemBase = {
        SK: 'METADATA',
        GSI1PK: gsi1pk,
        GSI1SK: gsi1sk,
        title: title ?? '',
        briefSummary: briefSummary ?? '',
        s3Path: `s3://${bucket}/${s3Key}`,
        status: status ?? 'PUBLISHED',
    };

    // Try to keep the example pattern: MATERIA#YYYYMMDD_001.
    // If it collides (replay/retry), increment the suffix.
    for (let seq = 1; seq <= 25; seq++) {
        const pk = `MATERIA#${yyyymmdd}_${String(seq).padStart(3, '0')}`;
        try {
            await ddb.send(
                new PutCommand({
                    TableName: tableName,
                    Item: {
                        PK: pk,
                        ...metadataItemBase,
                    },
                    ConditionExpression: 'attribute_not_exists(PK)',
                }),
            );

            if (enquete?.pergunta && Array.isArray(enquete.opcoes) && enquete.opcoes.length >= 2) {
                const votosIniciais: Record<string, number> = {};
                for (let i = 0; i < enquete.opcoes.length; i++) {
                    votosIniciais[`votos_opcao${i}`] = 0;
                }

                try {
                    await ddb.send(
                        new PutCommand({
                            TableName: tableName,
                            Item: {
                                PK: pk,
                                SK: 'ENQUETE',
                                pergunta: enquete.pergunta,
                                opcoes: enquete.opcoes,
                                ...votosIniciais,
                            },
                            ConditionExpression: 'attribute_not_exists(PK)',
                        }),
                    );
                } catch (err: any) {
                    console.warn('Falha ao gravar enquete no DynamoDB:', err?.name || err);
                }
            }

            return { pk };
        } catch (err: any) {
            if (err?.name === 'ConditionalCheckFailedException') {
                continue;
            }
            throw err;
        }
    }

    throw new Error(`Não foi possível gerar um PK único para ${yyyymmdd} após várias tentativas.`);
}

function decodeS3Key(encodedKey: string): string { 
    // S3 event keys are URL-encoded; '+' should be treated as space.
    return decodeURIComponent(encodedKey.replace(/\+/g, ' '));
}

function streamToString(body: any): Promise<string> {
    if (!body) return Promise.resolve('');
    if (typeof body === 'string') return Promise.resolve(body);
    if (Buffer.isBuffer(body)) return Promise.resolve(body.toString('utf8'));
    const readable = body as Readable;
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        readable.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        readable.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        readable.on('error', reject);
    });
}

function extractDateFromDiaryKey(key: string): { dateCompact?: string; dateBR?: string } {
    // Expected from watcher: diarios/diary-DDMMYYYY.txt
    const match = key.match(/diary-(\d{2})(\d{2})(\d{4})/i);
    if (!match) return {};
    const [, dd, mm, yyyy] = match;
    return {
        dateCompact: `${dd}${mm}${yyyy}`,
        dateBR: `${dd}/${mm}/${yyyy}`,
    };
}

async function generateNewsFromOpenAI(officialDiary: string, diaryDateBR?: string): Promise<News | { raw: string }> {
    const apiKey = await getOpenAIApiKey({ region });
    const client = new OpenAI({ apiKey });

    const dateInstruction = diaryDateBR
        ? `Use exatamente a data "${diaryDateBR}" no campo "date".`
        : 'Se a data não estiver clara, use a data mais provável inferida do documento.';

    const response = await client.responses.create({
        model: openAIModel,
        instructions:
            'Você é um jornalista experiente, especializado em economia e assuntos sociais. ' +
            'Sua tarefa é analisar o conteúdo do diário oficial da cidade de Guarulhos e escrever uma matéria jornalística ' +
            'destacando os eventos mais relevantes do ponto de vista econômico e social. A matéria deve ser clara, objetiva e informativa, ' +
            'destacando os impactos desses eventos na comunidade local.',
        input:
            'Gere um JSON com os campos "title", "date", "briefSummary", "content" e "enquete". ' +
            'No campo "briefSummary", gere um resumo curto (1-2 frases). ' +
            'No campo "content", escreva a matéria em Markdown, marcando todos os subtítulos com "##" e terminando com o subtítulo "## Conclusão". ' +
            'No campo "enquete", gere um objeto com "pergunta" (curta) e "opcoes" (array com 3 a 5 opções curtas, sem numeração). ' +
            `${dateInstruction}\n\n` +
            `DIÁRIO OFICIAL (conteúdo):\n${officialDiary}`,
        text: {
            format: zodTextFormat(NewsFormat, 'news'),
        },
    });

    const raw = response.output_text ?? '';
    try {
        const parsed = JSON.parse(raw);
        const validated = NewsFormat.safeParse(parsed);
        if (validated.success) return validated.data;
    } catch {
        // fall through
    }

    return { raw };
}

export const handler = async (event: any = {}, _context: any = {}): Promise<any> => {
    try {
        console.log('Recebido evento S3:', JSON.stringify(event));

        const record = event?.Records?.[0];
        const bucketFromEvent = record?.s3?.bucket?.name;
        const keyEncoded = record?.s3?.object?.key;
        if (!bucketFromEvent || !keyEncoded) {
            return { statusCode: 400, body: 'Evento S3 inválido (bucket/key ausentes).' };
        }

        const key = decodeS3Key(keyEncoded);
        if (bucketFromEvent !== EXPECTED_BUCKET) {
            console.warn(`Ignorando bucket inesperado: ${bucketFromEvent}`);
            return { statusCode: 202, body: 'Bucket inesperado; evento ignorado.' };
        }

        if (!key.startsWith('diarios/')) {
            console.warn(`Ignorando objeto fora de diarios/: ${key}`);
            return { statusCode: 202, body: 'Objeto fora de diarios/; evento ignorado.' };
        }

        console.log(`Lendo diário do S3: s3://${bucketFromEvent}/${key}`);
        const s3 = new S3Client({ region });
        const getResp = await s3.send(
            new GetObjectCommand({
                Bucket: bucketFromEvent,
                Key: key,
            }),
        );

        const diaryTextRaw = await streamToString(getResp.Body);
        if (!diaryTextRaw.trim()) {
            return { statusCode: 422, body: 'Diário vazio; nada para processar.' };
        }

        const diaryText = diaryTextRaw;
        const { dateCompact, dateBR } = extractDateFromDiaryKey(key);

        console.log('Gerando matéria via OpenAI...');
        const news = await generateNewsFromOpenAI(diaryText, dateBR);

        const outputDateCompact = dateCompact || new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const outputKey = `materias/materia-${outputDateCompact}.json`;


        await s3.send(
            new PutObjectCommand({
                Bucket: bucketFromEvent,
                Key: outputKey,
                Body: JSON.stringify(news, null, 2),
                ContentType: 'application/json',
            }),
        );

        console.log(`Matéria salva em: s3://${bucketFromEvent}/${outputKey}`);

        const yyyymmdd = ddmmyyyyToYyyymmdd(outputDateCompact) || new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const metadata = await putNewsMetadata({
            tableName: metadataTableName,
            region,
            bucket: bucketFromEvent,
            s3Key: outputKey,
            title: (news as any)?.title,
            briefSummary: (news as any)?.briefSummary,
            enquete: (news as any)?.enquete,
            status: 'PUBLISHED',
            yyyymmdd,
        });
        if (metadata?.pk) {
            console.log(`Metadados gravados no DynamoDB: PK=${metadata.pk} SK=METADATA`);
        }

        return { statusCode: 200, body: `OK: salvo em s3://${bucketFromEvent}/${outputKey}` };
    } catch (err: any) {
        console.error('Erro ao gerar matéria:', err);
        return { statusCode: 500, body: 'Erro ao processar o diário oficial.' };
    }
};
