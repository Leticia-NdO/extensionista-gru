import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as cheerio from 'cheerio';

const { DOMMatrix } = require('dommatrix');
;(global as any).DOMMatrix = (global as any).DOMMatrix || DOMMatrix;
const pdfParse = require('pdf-parse');

const BASE_URL = 'https://diariooficial.guarulhos.sp.gov.br/';

async function fetchLatestDiaryUrl(): Promise<{ url: string, date: Date } | null> {
    const html = await new Promise<string>((resolve, reject) => {
        https.get(BASE_URL, { timeout: 90000 }, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`Failed to get HTML, status code: ${res.statusCode}`));
                return;
            }
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => resolve(body));
        }).on('error', reject);
    });

    const $ = cheerio.load(html);
    const pdfLinks: { href: string, date: Date }[] = [];
    $('.diarios').each((_, el) => {
        const h3 = $(el).find('h3').text();
        // Example: "Diário da data: 14/04/2026"
        const dateMatch = h3.match(/(\d{2})\/(\d{2})\/(\d{4})/);
        if (!dateMatch) return;
        const date = new Date(`${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`);
        const pdfHref = $(el).find('a[href$=".pdf"]').attr('href');
        if (!pdfHref) return;
        pdfLinks.push({ href: pdfHref, date });
    });
    if (pdfLinks.length === 0) return null;
    pdfLinks.sort((a, b) => b.date.getTime() - a.date.getTime());
    const latest = pdfLinks[0];
    let link = latest.href;
    // Handle relative URLs like ../uploads/pdf/1645981087.pdf
    if (!/^https?:\/\//.test(link)) {
        // Remove leading ../ if present
        link = link.replace(/^\.\./, '');
        link = new URL(link, BASE_URL).href;
    }
    return { url: link, date: latest.date };
}

async function downloadFile(url: string, outputPath: string) {
    await new Promise((resolve, reject) => {
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download file, status code: ${response.statusCode}`));
                return;
            }
            const writer = fs.createWriteStream(outputPath);
            response.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        }).on('error', reject);
    });
}

async function objectExists(s3: S3Client, bucket: string, key: string): Promise<boolean> {
    try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
    } catch (error: any) {
        const statusCode = error?.$metadata?.httpStatusCode;
        if (statusCode === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchKey') {
            return false;
        }
        throw error;
    }
}

export const handler = async (event: any = {}, context: any = {}): Promise<any> => {
    try {
        console.log('Buscando o link do diário oficial mais recente...');
        const result = await fetchLatestDiaryUrl();
        if (!result) {
            console.error('Não foi possível encontrar o diário oficial.');
            return { statusCode: 404, body: 'Diário oficial não encontrado.' };
        }
        const { url: diaryUrl, date: diaryDate } = result;
        // Format date as DDMMYYYY
        const day = String(diaryDate.getDate()).padStart(2, '0');
        const month = String(diaryDate.getMonth() + 1).padStart(2, '0');
        const year = diaryDate.getFullYear();
        const baseName = `diary-${day}${month}${year}`;
        const bucket = process.env.S3_BUCKET_NAME;
        const region = process.env.AWS_REGION || 'us-east-1';
        if (!bucket) {
            throw new Error('S3_BUCKET_NAME environment variable not set');
        }
        const s3 = new S3Client({ region });
        const s3Key = `diarios/${baseName}.txt`;

        if (await objectExists(s3, bucket, s3Key)) {
            console.log(`Diário já processado em s3://${bucket}/${s3Key}; encerrando execução.`);
            return { statusCode: 200, body: `Diário oficial já processado em s3://${bucket}/${s3Key}` };
        }

        const pdfPath = path.join('/tmp', `${baseName}.pdf`);
        // Use /tmp for Lambda compatibility
        console.log(`Baixando: ${diaryUrl}`);
        await downloadFile(diaryUrl, pdfPath);
        console.log(`Diário oficial salvo em: ${pdfPath}`);

        // Extract text from PDF
        const pdfBuffer = fs.readFileSync(pdfPath);
        const pdfData = await pdfParse(pdfBuffer);

        // Limit to first 500 KiB of UTF-8 text to keep payload small/predictable
        const maxBytes = 500 * 1024;
        const fullTextBuffer = Buffer.from(pdfData.text ?? '', 'utf8');
        let end = Math.min(fullTextBuffer.length, maxBytes);
        // Avoid cutting in the middle of a multi-byte UTF-8 sequence
        while (end > 0 && (fullTextBuffer[end - 1] & 0b1100_0000) === 0b1000_0000) {
            end--;
        }
        const limitedText = fullTextBuffer.toString('utf8', 0, end);

        // Upload extracted text to S3
        await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: s3Key,
            Body: limitedText,
            ContentType: 'text/plain',
        }));
        console.log(`Texto extraído enviado para o S3: s3://${bucket}/${s3Key}`);
        return { statusCode: 200, body: `Diário oficial processado e salvo em s3://${bucket}/${s3Key}` };
    } catch (err: any) {
        console.error('Erro ao baixar o diário oficial:', err);
        return { statusCode: 500, body: 'Erro ao processar o diário oficial.' };
    }
};
