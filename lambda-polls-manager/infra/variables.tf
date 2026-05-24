variable "region" {
    type    = string
    default = "us-east-1"
}

variable "function_name" {
    type    = string
    default = "lambda-polls-manager"
}

variable "runtime" {
    type    = string
    default = "nodejs24.x"
}

variable "handler" {
    type    = string
    default = "app.handler"
}

variable "dynamodb_table_name" {
  type    = string
  default = "extensionista-materias"
}
