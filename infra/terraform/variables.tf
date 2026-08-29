variable "name" {
  type    = string
  default = "taxops-ai"
}

variable "environment" {
  type    = string
  default = "production"
}

variable "aws_region" {
  type    = string
  default = "ap-northeast-2"
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "alb_security_group_id" {
  type = string
}

variable "target_group_arn" {
  type = string
}

variable "web_image" {
  type = string
}

variable "worker_image" {
  type = string
}

variable "reviewer_image" {
  type        = string
  description = "Immutable container image for the isolated reviewer decision service."
}

variable "database_url_secret_arn" {
  type        = string
  description = "Secrets Manager ARN containing the full RLS application-role DATABASE_URL."
}

variable "review_database_url_secret_arn" {
  type        = string
  description = "Secrets Manager ARN containing the restricted reviewer-decision role DATABASE_URL."
}

variable "review_service_shared_secret_arn" {
  type        = string
  description = "Secrets Manager ARN containing at least 32 random base64url bytes for encrypted web-to-reviewer envelopes."
}

variable "terraform_deployer_role_arn" {
  type        = string
  description = "Exact IAM role ARN used for Terraform apply; granted only the CMK grant/describe operations required by RDS and Logs provisioning."
  validation {
    condition     = can(regex("^arn:[^:]+:iam::[0-9]{12}:role/", var.terraform_deployer_role_arn))
    error_message = "terraform_deployer_role_arn must be an IAM role ARN."
  }
}

variable "worker_database_url_secret_arn" {
  type        = string
  description = "Secrets Manager ARN containing the restricted worker-role DATABASE_URL."
}

variable "ai_gateway_key_secret_arn" {
  type = string
}

variable "secret_kms_key_arns" {
  type        = list(string)
  description = "Customer-managed KMS key ARNs used by externally supplied Secrets Manager secrets."
  validation {
    condition = length(var.secret_kms_key_arns) > 0 && alltrue([
      for arn in var.secret_kms_key_arns : can(regex("^arn:[^:]+:kms:[^:]+:[0-9]{12}:key/", arn))
    ])
    error_message = "secret_kms_key_arns must contain at least one customer-managed KMS key ARN."
  }
}

variable "ai_provider_data_region" {
  type        = string
  description = "Declared processing region guaranteed by the configured AI provider."
  default     = "ap-northeast-2"
}

variable "ai_input_krw_per_mtok" {
  type        = number
  description = "Production input-token price used by the request budget guard."
  default     = 5000
  validation {
    condition     = var.ai_input_krw_per_mtok >= 0
    error_message = "ai_input_krw_per_mtok must be non-negative."
  }
}

variable "ai_output_krw_per_mtok" {
  type        = number
  description = "Production output-token price used by the request budget guard."
  default     = 25000
  validation {
    condition     = var.ai_output_krw_per_mtok >= 0
    error_message = "ai_output_krw_per_mtok must be non-negative."
  }
}

variable "pii_dlp_url" {
  type        = string
  description = "HTTPS batch DLP/NER endpoint used before AI-provider egress."
}

variable "pii_dlp_token_secret_arn" {
  type        = string
  description = "Secrets Manager ARN containing the DLP service bearer token."
}

variable "pii_dlp_data_region" {
  type        = string
  description = "Declared processing region guaranteed by the configured DLP provider."
  default     = "ap-northeast-2"
}

variable "prompt_injection_classifier_url" {
  type        = string
  description = "Authenticated HTTPS semantic classifier endpoint for source-controlled prompt injection."
  validation {
    condition     = can(regex("^https://", var.prompt_injection_classifier_url))
    error_message = "prompt_injection_classifier_url must use HTTPS."
  }
}

variable "prompt_injection_classifier_token_secret_arn" {
  type        = string
  description = "Secrets Manager ARN containing the semantic classifier bearer token."
}

variable "prompt_injection_classifier_data_region" {
  type        = string
  description = "Declared processing region guaranteed by the semantic classifier."
  default     = "ap-northeast-2"
}

variable "prompt_injection_classifier_allowed_hosts" {
  type        = string
  description = "Comma-separated exact HTTPS host allowlist for the semantic classifier."
}

variable "prompt_injection_classifier_threshold" {
  type        = number
  description = "Risk threshold echoed by the semantic classifier and enforced by the application."
  default     = 0.5
  validation {
    condition     = var.prompt_injection_classifier_threshold >= 0.1 && var.prompt_injection_classifier_threshold <= 0.99
    error_message = "prompt_injection_classifier_threshold must be between 0.1 and 0.99."
  }
}

variable "approval_token_secret_arn" {
  type = string
}

variable "oidc_client_secret_arn" {
  type        = string
  description = "Secrets Manager ARN containing the confidential OIDC client secret."
}

variable "session_secret_arn" {
  type        = string
  description = "Secrets Manager ARN containing a random session signing secret of at least 32 characters."
}

variable "health_detail_token_secret_arn" {
  type        = string
  description = "Secrets Manager ARN containing the internal readiness detail bearer token."
}

variable "document_processor_token_secret_arn" {
  type = string
}

variable "notification_webhook_secret_arn" {
  type        = string
  description = "Secrets Manager ARN containing the HMAC secret for notification delivery."
}

variable "oidc_issuer" {
  type = string
}

variable "oidc_audience" {
  type = string
}

variable "oidc_jwks_url" {
  type = string
}

variable "oidc_authorization_url" {
  type = string
}

variable "oidc_token_url" {
  type = string
}

variable "oidc_client_id" {
  type = string
}

variable "oidc_review_audience" {
  type        = string
  description = "Dedicated JWT access-token audience accepted only by the reviewer service."
}

variable "oidc_review_scope" {
  type        = string
  description = "OAuth scope required for reviewer mutations."
  default     = "review:decide"
}

variable "oidc_review_resource_parameter" {
  type        = string
  description = "OAuth authorization parameter used to request the reviewer API audience. Use resource for RFC 8707 or audience for IdP-specific deployments."
  default     = "resource"
  validation {
    condition     = contains(["resource", "audience"], var.oidc_review_resource_parameter)
    error_message = "oidc_review_resource_parameter must be resource or audience."
  }
}

variable "oidc_review_required_acr" {
  type        = string
  description = "Exact IdP ACR value proving recent step-up/MFA for reviewer decisions."
}

variable "app_base_url" {
  type        = string
  description = "Public HTTPS origin used for the OIDC redirect URI."
}

variable "public_hostname" {
  type = string
}

variable "clamav_host" {
  type        = string
  description = "Private DNS name of a highly available ClamAV service."
}

variable "document_processor_url" {
  type = string
}

variable "document_processor_data_region" {
  type        = string
  description = "Declared processing region guaranteed by the document extraction service."
  default     = "ap-northeast-2"
}

variable "document_processor_allowed_hosts" {
  type        = string
  description = "Comma-separated exact HTTPS host allowlist for document extraction."
}

variable "notification_webhook_url" {
  type        = string
  description = "HTTPS endpoint receiving signed, idempotent outbox notifications."
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "alarm_sns_topic_arns" {
  type        = list(string)
  description = "SNS topic ARNs receiving production CloudWatch alarms."
  validation {
    condition     = length(var.alarm_sns_topic_arns) > 0
    error_message = "At least one SNS alarm topic ARN is required for production alerts."
  }
}
