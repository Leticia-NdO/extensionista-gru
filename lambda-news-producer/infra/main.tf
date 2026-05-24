terraform {
    required_version = ">= 1.0"
    required_providers {
        aws = {
            source  = "hashicorp/aws"
            version = "~> 6.19.0"
        }
        archive = {
            source  = "hashicorp/archive"
            version = "~> 2.0"
        }
    }
}

provider "aws" {
    region = var.region
}

data "aws_s3_bucket" "this" {
    bucket = var.s3_bucket_name
}

resource "aws_dynamodb_table" "materias" {
    name         = var.dynamodb_table_name
    billing_mode = "PAY_PER_REQUEST"

    hash_key  = "PK"
    range_key = "SK"

    attribute {
        name = "PK"
        type = "S"
    }

    attribute {
        name = "SK"
        type = "S"
    }

    attribute {
        name = "GSI1PK"
        type = "S"
    }

    attribute {
        name = "GSI1SK"
        type = "S"
    }

    global_secondary_index {
        name            = "GSI1"
        hash_key        = "GSI1PK"
        range_key       = "GSI1SK"
        projection_type = "ALL"
    }
}

data "archive_file" "lambda_zip" {
    type        = "zip"
    source_dir  = "${path.module}/../lambda/dist"
    output_path = "${path.module}/../lambda.zip"
}

resource "aws_iam_role" "lambda_role" {
    name = "${var.function_name}-role"

    assume_role_policy = jsonencode({
        Version = "2012-10-17"
        Statement = [{
            Sid: "StsAssumeLambdaRole",
            Action = "sts:AssumeRole",
            Effect = "Allow",
            Principal = {
                Service = "lambda.amazonaws.com"
            }
        }]
    })
}

resource "aws_iam_role_policy" "lambda_policy" {
    name = "${var.function_name}-policy"
    role = aws_iam_role.lambda_role.id
    policy = jsonencode({
        Version = "2012-10-17",
        Statement = [
            {
                Sid: "S3Access",
                Effect = "Allow",
                Action = [
                    "s3:PutObject",
                    "s3:GetObject",
                    "s3:ListBucket"
                ],
                Resource = [
                    "arn:aws:s3:::${var.s3_bucket_name}",
                    "arn:aws:s3:::${var.s3_bucket_name}/*"
                ]
            },
            {
                Sid: "SecretsManagerAccess",
                Effect = "Allow",
                Action = [
                    "secretsmanager:GetSecretValue"
                ],
                Resource = "arn:aws:secretsmanager:${var.region}:*:secret:${var.openai_api_key}*"
            },
            {
                Sid: "DynamoDBPutMetadata",
                Effect = "Allow",
                Action = [
                    "dynamodb:PutItem"
                ],
                Resource = aws_dynamodb_table.materias.arn
            }
        ]
    })
}

resource "aws_iam_role_policy_attachment" "lambda_basic_execution" {
    role       = aws_iam_role.lambda_role.name
    policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "this" {
    filename         = data.archive_file.lambda_zip.output_path
    function_name    = var.function_name
    role             = aws_iam_role.lambda_role.arn
    handler          = "app.handler"
runtime          = "nodejs24.x"
    source_code_hash = data.archive_file.lambda_zip.output_base64sha256
    publish          = true
    memory_size      = 512
    timeout          = 850
    environment {
      variables = {
                OPENAI_SECRET_ID = var.openai_api_key
        S3_BUCKET_NAME = var.s3_bucket_name
        S3_REGION      = var.region
                DDB_TABLE_NAME = var.dynamodb_table_name
      }
    }
}

resource "aws_lambda_permission" "allow_s3_invoke" {
        statement_id  = "AllowExecutionFromS3"
        action        = "lambda:InvokeFunction"
        function_name = aws_lambda_function.this.arn
        principal     = "s3.amazonaws.com"
        source_arn    = data.aws_s3_bucket.this.arn
}

resource "aws_s3_bucket_notification" "diarios_to_news_producer" {
        bucket = data.aws_s3_bucket.this.id

        lambda_function {
                lambda_function_arn = aws_lambda_function.this.arn
                events              = ["s3:ObjectCreated:*"]
                filter_prefix       = "diarios/"
        }

        depends_on = [aws_lambda_permission.allow_s3_invoke]
}

// Attach the managed policy that allows Lambda to manage ENIs when placed in a VPC
resource "aws_iam_role_policy_attachment" "lambda_vpc_access" {
    role       = aws_iam_role.lambda_role.name
    policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

output "lambda_name" {
    value = aws_lambda_function.this.function_name
}

output "lambda_arn" {
    value = aws_lambda_function.this.arn
}