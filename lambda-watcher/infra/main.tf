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

# data "aws_subnet" "nat_public" {
#   id = var.nat_public_subnet_id
# }

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
      Sid : "StsAssumeLambdaRole",
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
        Sid : "S3Access",
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
        Sid : "SecretsManagerAccess",
        Effect = "Allow",
        Action = [
          "secretsmanager:GetSecretValue"
        ],
        Resource = "arn:aws:secretsmanager:${var.region}:*:secret:${var.openai_api_key}*"
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
      OPENAI_API_KEY = var.openai_api_key
      S3_BUCKET_NAME = var.s3_bucket_name
      S3_REGION      = var.region
    }
  }
}

// Attach the managed policy that allows Lambda to manage ENIs when placed in a VPC
resource "aws_iam_role_policy_attachment" "lambda_vpc_access" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_cloudwatch_log_group" "lambda_logs" {
  name              = "/aws/lambda/${aws_lambda_function.this.function_name}"
  retention_in_days = 30
}

resource "aws_iam_role" "scheduler_role" {
  name = "${var.function_name}-scheduler-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid : "StsAssumeSchedulerRole",
      Action = "sts:AssumeRole",
      Effect = "Allow",
      Principal = {
        Service = "scheduler.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy" "scheduler_policy" {
  name = "${var.function_name}-scheduler-policy"
  role = aws_iam_role.scheduler_role.id
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Sid : "InvokeLambda",
        Effect = "Allow",
        Action = [
          "lambda:InvokeFunction"
        ],
        Resource = [
          aws_lambda_function.this.arn,
          "${aws_lambda_function.this.arn}:*"
        ]
      }
    ]
  })
}

resource "aws_scheduler_schedule" "watcher" {
  name                         = "${var.function_name}-schedule"
  description                  = "Invoca o lambda-watcher em horarios comerciais"
  group_name                   = "default"
  schedule_expression          = "cron(0 8,12,18 ? * MON-FRI *)"
  schedule_expression_timezone = "America/Sao_Paulo"
  flexible_time_window {
    mode = "OFF"
  }
  target {
    arn      = aws_lambda_function.this.arn
    role_arn = aws_iam_role.scheduler_role.arn
  }
}

resource "aws_lambda_permission" "allow_scheduler" {
  statement_id  = "AllowEventBridgeSchedulerInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this.function_name
  principal     = "scheduler.amazonaws.com"
  source_arn    = aws_scheduler_schedule.watcher.arn
}

output "lambda_name" {
  value = aws_lambda_function.this.function_name
}

output "lambda_arn" {
  value = aws_lambda_function.this.arn
}
