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

data "aws_dynamodb_table" "materias" {
    name = var.dynamodb_table_name
}

data "terraform_remote_state" "newsfeed" {
    backend = "local"
    config = {
        path = "${path.module}/../../lambda-get-newsfeed/infra/terraform.tfstate"
    }
}

data "archive_file" "lambda_zip" {
    type       = "zip"
    source_dir = "${path.module}/../lambda/dist"
    output_path = "${path.module}/../lambda.zip"
}

resource "aws_iam_role" "lambda_role" {
    name = "${var.function_name}-role"

    assume_role_policy = jsonencode({
        Version = "2012-10-17"
        Statement = [{
            Sid: "StsAssumeLambdaRole"
            Action = "sts:AssumeRole"
            Effect = "Allow"
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
                Sid: "DynamoDBUpdateVote",
                Effect = "Allow",
                Action = [
                    "dynamodb:UpdateItem"
                ],
                Resource = [
                    data.aws_dynamodb_table.materias.arn
                ]
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
    handler          = var.handler
    runtime          = var.runtime
    source_code_hash = data.archive_file.lambda_zip.output_base64sha256
    publish          = true
    memory_size      = 256
    timeout          = 30

    environment {
      variables = {
        DDB_TABLE_NAME = var.dynamodb_table_name
      }
    }
}

resource "aws_apigatewayv2_integration" "polls_lambda" {
    api_id                 = data.terraform_remote_state.newsfeed.outputs.http_api_id
    integration_type       = "AWS_PROXY"
    integration_uri        = aws_lambda_function.this.arn
    payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "vote" {
    api_id    = data.terraform_remote_state.newsfeed.outputs.http_api_id
    route_key = "POST /materias/{pk}/voto"
    target    = "integrations/${aws_apigatewayv2_integration.polls_lambda.id}"
}

resource "aws_lambda_permission" "allow_apigw_invoke" {
    statement_id  = "AllowExecutionFromAPIGateway"
    action        = "lambda:InvokeFunction"
    function_name = aws_lambda_function.this.function_name
    principal     = "apigateway.amazonaws.com"
    source_arn    = "${data.terraform_remote_state.newsfeed.outputs.http_api_execution_arn}/*/*"
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
