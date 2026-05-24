variable "region" {
  type    = string
  default = "us-east-1"
}

variable "function_name" {
  type    = string
  default = "lambda-watcher"
}

variable "runtime" {
  type    = string
  default = "nodejs24.x"
}

variable "handler" {
  type    = string
  default = "app.handler"
}

variable "openai_api_key" {
  type    = string
  default = "llm/openapi-secret"
}

variable "s3_bucket_name" {
  type    = string
  default = "extensionista-gru-1"
}