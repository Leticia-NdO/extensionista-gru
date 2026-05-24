variable "region" {
  type    = string
  default = "sa-east-1"
}

variable "bucket_name" {
  type    = string
  default = "portal-extensionista-gru"
}

variable "api_gateway_domain" {
  type = string
  description = "Domain do API Gateway (ex: abcdef.execute-api.sa-east-1.amazonaws.com)"
}

variable "api_origin_secret" {
  type      = string
  sensitive = true
  description = "Segredo compartilhado enviado pelo CloudFront ao origin da API"
}
