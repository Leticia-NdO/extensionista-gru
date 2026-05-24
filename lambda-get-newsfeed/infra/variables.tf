variable "region" {
    type    = string
    default = "us-east-1"
}

variable "function_name" {
    type    = string
  default = "lambda-get-newsfeed"
}

variable "runtime" {
    type    = string
    default = "nodejs24.x"
}

variable "handler" {
    type    = string
    default = "app.handler"
}

variable "s3_bucket_name" {
  type = string
  default = "extensionista-gru-1"
}

variable "dynamodb_table_name" {
  type    = string
  default = "extensionista-materias"
}

variable "api_origin_secret" {
  type      = string
  sensitive = true
  description = "Segredo esperado no header x-origin-secret enviado pelo CloudFront"
}

variable "cors_allow_origin" {
  type        = string
  description = "Origem permitida no CORS (ex: https://dxxxxx.cloudfront.net)"
}
