locals {
  prefix = "${var.name}-${var.environment}"
  common_environment = [
    { name = "AWS_REGION", value = var.aws_region },
    { name = "OBJECT_BUCKET", value = aws_s3_bucket.documents.id },
    { name = "S3_KMS_KEY_ID", value = aws_kms_key.data.arn },
    { name = "AI_MODEL_ID", value = "openai/gpt-5.6-sol" },
    { name = "AI_VERIFIER_MODEL_ID", value = "openai/gpt-5.6-terra" },
    { name = "AI_EMBEDDING_MODEL_ID", value = "openai/text-embedding-3-small" },
    { name = "AI_PROVIDER_DATA_REGION", value = var.ai_provider_data_region },
    { name = "AI_INPUT_KRW_PER_MTOK", value = tostring(var.ai_input_krw_per_mtok) },
    { name = "AI_OUTPUT_KRW_PER_MTOK", value = tostring(var.ai_output_krw_per_mtok) },
    { name = "PII_DLP_URL", value = var.pii_dlp_url },
    { name = "PII_DLP_DATA_REGION", value = var.pii_dlp_data_region },
    { name = "PROMPT_INJECTION_CLASSIFIER_URL", value = var.prompt_injection_classifier_url },
    { name = "PROMPT_INJECTION_CLASSIFIER_DATA_REGION", value = var.prompt_injection_classifier_data_region },
    { name = "PROMPT_INJECTION_CLASSIFIER_ALLOWED_HOSTS", value = var.prompt_injection_classifier_allowed_hosts },
    { name = "PROMPT_INJECTION_CLASSIFIER_THRESHOLD", value = tostring(var.prompt_injection_classifier_threshold) },
  ]
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_iam_policy_document" "data_kms" {
  statement {
    sid       = "EnableAccountKeyAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type = "AWS"
      identifiers = [
        "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"
      ]
    }
  }

  statement {
    sid = "AllowCloudWatchLogsEncryption"
    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
    ]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${var.aws_region}.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values = [
        "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/ecs/${local.prefix}/*",
        "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/rds/instance/${local.prefix}/*",
      ]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["logs.${var.aws_region}.amazonaws.com"]
    }
  }

  statement {
    sid       = "AllowTerraformDescribeForManagedServices"
    actions   = ["kms:DescribeKey"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [var.terraform_deployer_role_arn]
    }
  }

  statement {
    sid       = "AllowTerraformRdsGrantCreation"
    actions   = ["kms:CreateGrant"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [var.terraform_deployer_role_arn]
    }
    condition {
      test     = "Bool"
      variable = "kms:GrantIsForAWSResource"
      values   = ["true"]
    }
  }
}

resource "aws_kms_key" "data" {
  description             = "TaxOps restricted data encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.data_kms.json
}

resource "aws_kms_alias" "data" {
  name          = "alias/${local.prefix}-data"
  target_key_id = aws_kms_key.data.key_id
}

resource "aws_s3_bucket" "documents" {
  bucket_prefix = "${local.prefix}-documents-"
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "documents_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.documents.arn, "${aws_s3_bucket.documents.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
  statement {
    sid       = "DenyNonKmsObjectWrites"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.documents.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }
  statement {
    sid       = "DenyWrongObjectKmsKey"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.documents.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [aws_kms_key.data.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "documents" {
  bucket = aws_s3_bucket.documents.id
  policy = data.aws_iam_policy_document.documents_bucket.json
}

resource "aws_s3_bucket_versioning" "documents" {
  bucket = aws_s3_bucket.documents.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.data.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  bucket     = aws_s3_bucket.documents.id
  depends_on = [aws_s3_bucket_versioning.documents]
  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
    noncurrent_version_expiration { noncurrent_days = 90 }
  }
  rule {
    id     = "expire-unpromoted-quarantine"
    status = "Enabled"
    filter {
      tag {
        key   = "lifecycle"
        value = "quarantine"
      }
    }
    expiration { days = 7 }
    noncurrent_version_expiration { noncurrent_days = 1 }
  }
  rule {
    id     = "expire-malware-retention"
    status = "Enabled"
    filter {
      tag {
        key   = "lifecycle"
        value = "malware"
      }
    }
    expiration { days = 90 }
    noncurrent_version_expiration { noncurrent_days = 1 }
  }
  rule {
    id     = "expire-failed-processing"
    status = "Enabled"
    filter {
      tag {
        key   = "lifecycle"
        value = "failed"
      }
    }
    expiration { days = 30 }
    noncurrent_version_expiration { noncurrent_days = 1 }
  }
  rule {
    id     = "remove-expired-delete-markers"
    status = "Enabled"
    filter {}
    expiration { expired_object_delete_marker = true }
  }
}

resource "aws_security_group" "tasks" {
  name_prefix = "${local.prefix}-tasks-"
  description = "TaxOps ECS tasks"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_vpc_security_group_ingress_rule" "web_from_alb" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = var.alb_security_group_id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "reviewer_from_tasks" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.tasks.id
  from_port                    = 3100
  to_port                      = 3100
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "database" {
  name_prefix = "${local.prefix}-db-"
  description = "TaxOps PostgreSQL"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "database_from_tasks" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.tasks.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_db_subnet_group" "database" {
  name       = local.prefix
  subnet_ids = var.private_subnet_ids
}

resource "aws_db_instance" "database" {
  identifier                      = local.prefix
  engine                          = "postgres"
  engine_version                  = "16.4"
  instance_class                  = "db.t4g.medium"
  allocated_storage               = 100
  max_allocated_storage           = 500
  storage_type                    = "gp3"
  storage_encrypted               = true
  kms_key_id                      = aws_kms_key.data.arn
  db_name                         = "taxops"
  username                        = "taxops_owner"
  manage_master_user_password     = true
  port                            = 5432
  db_subnet_group_name            = aws_db_subnet_group.database.name
  vpc_security_group_ids          = [aws_security_group.database.id]
  multi_az                        = true
  backup_retention_period         = 14
  copy_tags_to_snapshot           = true
  deletion_protection             = var.deletion_protection
  skip_final_snapshot             = !var.deletion_protection
  final_snapshot_identifier       = var.deletion_protection ? "${local.prefix}-final" : null
  auto_minor_version_upgrade      = true
  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.data.arn
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  depends_on = [
    aws_cloudwatch_log_group.rds_postgresql,
    aws_cloudwatch_log_group.rds_upgrade,
  ]
}

resource "aws_ecs_cluster" "main" {
  name = local.prefix
  setting {
    name  = "containerInsights"
    value = "enhanced"
  }
}

resource "aws_service_discovery_private_dns_namespace" "internal" {
  name = "${local.prefix}.internal"
  vpc  = var.vpc_id
}

resource "aws_service_discovery_service" "reviewer" {
  name = "reviewer"
  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.internal.id
    routing_policy = "MULTIVALUE"
    dns_records {
      ttl  = 10
      type = "A"
    }
  }
  health_check_custom_config {}
}

resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/${local.prefix}/web"
  retention_in_days = 90
  kms_key_id        = aws_kms_key.data.arn
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${local.prefix}/worker"
  retention_in_days = 90
  kms_key_id        = aws_kms_key.data.arn
}

resource "aws_cloudwatch_log_group" "reviewer" {
  name              = "/ecs/${local.prefix}/reviewer"
  retention_in_days = 90
  kms_key_id        = aws_kms_key.data.arn
}

resource "aws_cloudwatch_log_group" "rds_postgresql" {
  name              = "/aws/rds/instance/${local.prefix}/postgresql"
  retention_in_days = 90
  kms_key_id        = aws_kms_key.data.arn
}

resource "aws_cloudwatch_log_group" "rds_upgrade" {
  name              = "/aws/rds/instance/${local.prefix}/upgrade"
  retention_in_days = 90
  kms_key_id        = aws_kms_key.data.arn
}

resource "aws_cloudwatch_log_metric_filter" "ai_run_failed" {
  name           = "${local.prefix}-ai-run-failed"
  log_group_name = aws_cloudwatch_log_group.web.name
  pattern        = "{ $.event = \"ai.run_failed\" }"
  metric_transformation {
    name      = "AiRunFailed"
    namespace = "TaxOps/${local.prefix}"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "ai_run_latency" {
  name           = "${local.prefix}-ai-run-latency"
  log_group_name = aws_cloudwatch_log_group.web.name
  pattern        = "{ $.event = \"ai.run_completed\" && $.latencyMs = * }"
  metric_transformation {
    name      = "AiRunLatencyMs"
    namespace = "TaxOps/${local.prefix}"
    value     = "$.latencyMs"
    unit      = "Milliseconds"
  }
}

resource "aws_cloudwatch_log_metric_filter" "ai_run_cost" {
  name           = "${local.prefix}-ai-run-cost"
  log_group_name = aws_cloudwatch_log_group.web.name
  pattern        = "{ $.event = \"ai.run_completed\" && $.estimatedCostKrw = * }"
  metric_transformation {
    name      = "AiEstimatedCostKrw"
    namespace = "TaxOps/${local.prefix}"
    value     = "$.estimatedCostKrw"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "worker_job_failed" {
  name           = "${local.prefix}-worker-job-failed"
  log_group_name = aws_cloudwatch_log_group.worker.name
  pattern        = "{ $.event = \"job.failed\" }"
  metric_transformation {
    name      = "WorkerJobFailed"
    namespace = "TaxOps/${local.prefix}"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "worker_heartbeat_failed" {
  name           = "${local.prefix}-worker-heartbeat-failed"
  log_group_name = aws_cloudwatch_log_group.worker.name
  pattern        = "{ $.event = \"worker.heartbeat_failed\" }"
  metric_transformation {
    name      = "WorkerHeartbeatFailed"
    namespace = "TaxOps/${local.prefix}"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "ai_tool_failed" {
  name           = "${local.prefix}-ai-tool-failed"
  log_group_name = aws_cloudwatch_log_group.web.name
  pattern        = "{ $.event = \"ai.tool_failed\" }"
  metric_transformation {
    name      = "AiToolFailed"
    namespace = "TaxOps/${local.prefix}"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "ai_verifier_rejected" {
  name           = "${local.prefix}-ai-verifier-rejected"
  log_group_name = aws_cloudwatch_log_group.web.name
  pattern        = "{ $.event = \"ai.verifier_rejected\" }"
  metric_transformation {
    name      = "AiVerifierRejected"
    namespace = "TaxOps/${local.prefix}"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "security_access_denied" {
  name           = "${local.prefix}-security-access-denied"
  log_group_name = aws_cloudwatch_log_group.web.name
  pattern        = "{ $.event = \"security.access_denied\" }"
  metric_transformation {
    name      = "SecurityAccessDenied"
    namespace = "TaxOps/${local.prefix}"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "worker_queue_age" {
  name           = "${local.prefix}-worker-queue-age"
  log_group_name = aws_cloudwatch_log_group.worker.name
  pattern        = "{ $.event = \"worker.operational_metrics\" && $.queueOldestSeconds = * }"
  metric_transformation {
    name      = "QueueOldestSeconds"
    namespace = "TaxOps/${local.prefix}"
    value     = "$.queueOldestSeconds"
    unit      = "Seconds"
  }
}

resource "aws_cloudwatch_log_metric_filter" "worker_dead_jobs" {
  name           = "${local.prefix}-worker-dead-jobs"
  log_group_name = aws_cloudwatch_log_group.worker.name
  pattern        = "{ $.event = \"worker.operational_metrics\" && $.deadJobs = * }"
  metric_transformation {
    name      = "DeadJobs"
    namespace = "TaxOps/${local.prefix}"
    value     = "$.deadJobs"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "worker_stuck_outbox" {
  name           = "${local.prefix}-worker-stuck-outbox"
  log_group_name = aws_cloudwatch_log_group.worker.name
  pattern        = "{ $.event = \"worker.operational_metrics\" && $.stuckOutbox = * }"
  metric_transformation {
    name      = "StuckOutbox"
    namespace = "TaxOps/${local.prefix}"
    value     = "$.stuckOutbox"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "ai_failures" {
  alarm_name          = "${local.prefix}-ai-failures"
  alarm_description   = "At least one production AI run failed in five minutes."
  namespace           = "TaxOps/${local.prefix}"
  metric_name         = "AiRunFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_sns_topic_arns
}

resource "aws_cloudwatch_metric_alarm" "ai_latency_p95" {
  alarm_name          = "${local.prefix}-ai-latency-p95"
  alarm_description   = "AI p95 latency exceeded the 20 second SLO."
  namespace           = "TaxOps/${local.prefix}"
  metric_name         = "AiRunLatencyMs"
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 20000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_sns_topic_arns
}

resource "aws_cloudwatch_metric_alarm" "worker_failures" {
  alarm_name          = "${local.prefix}-worker-failures"
  alarm_description   = "At least one ingestion job failed in five minutes."
  namespace           = "TaxOps/${local.prefix}"
  metric_name         = "WorkerJobFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_sns_topic_arns
}

resource "aws_cloudwatch_metric_alarm" "ai_tool_failures" {
  alarm_name          = "${local.prefix}-ai-tool-failures"
  alarm_description   = "At least one AI tool execution failed in five minutes."
  namespace           = "TaxOps/${local.prefix}"
  metric_name         = "AiToolFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_sns_topic_arns
}

resource "aws_cloudwatch_metric_alarm" "security_denials" {
  alarm_name          = "${local.prefix}-security-denials"
  alarm_description   = "Repeated authentication or authorization denials were observed."
  namespace           = "TaxOps/${local.prefix}"
  metric_name         = "SecurityAccessDenied"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_sns_topic_arns
}

resource "aws_cloudwatch_metric_alarm" "queue_age" {
  alarm_name          = "${local.prefix}-queue-age"
  alarm_description   = "The oldest queued ingestion job exceeded five minutes."
  namespace           = "TaxOps/${local.prefix}"
  metric_name         = "QueueOldestSeconds"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 300
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = var.alarm_sns_topic_arns
}

resource "aws_cloudwatch_metric_alarm" "dead_jobs" {
  alarm_name          = "${local.prefix}-dead-jobs"
  alarm_description   = "At least one ingestion job is in the dead-letter state."
  namespace           = "TaxOps/${local.prefix}"
  metric_name         = "DeadJobs"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = var.alarm_sns_topic_arns
}

resource "aws_cloudwatch_metric_alarm" "stuck_outbox" {
  alarm_name          = "${local.prefix}-stuck-outbox"
  alarm_description   = "At least one outbox event exhausted ten delivery attempts."
  namespace           = "TaxOps/${local.prefix}"
  metric_name         = "StuckOutbox"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = var.alarm_sns_topic_arns
}

resource "aws_cloudwatch_metric_alarm" "ai_request_cost" {
  alarm_name          = "${local.prefix}-ai-request-cost"
  alarm_description   = "An AI request exceeded the configured 300 KRW request budget."
  namespace           = "TaxOps/${local.prefix}"
  metric_name         = "AiEstimatedCostKrw"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 300
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_sns_topic_arns
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "web_execution" {
  name_prefix        = "${local.prefix}-web-execution-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "web_execution" {
  role       = aws_iam_role.web_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "worker_execution" {
  name_prefix        = "${local.prefix}-worker-execution-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "worker_execution" {
  role       = aws_iam_role.worker_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "reviewer_execution" {
  name_prefix        = "${local.prefix}-reviewer-execution-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "reviewer_execution" {
  role       = aws_iam_role.reviewer_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "web_execution_secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      var.database_url_secret_arn,
      var.ai_gateway_key_secret_arn,
      var.pii_dlp_token_secret_arn,
      var.prompt_injection_classifier_token_secret_arn,
      var.review_service_shared_secret_arn,
      var.oidc_client_secret_arn,
      var.session_secret_arn,
      var.health_detail_token_secret_arn,
    ]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = var.secret_kms_key_arns
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "web_execution_secrets" {
  role   = aws_iam_role.web_execution.id
  policy = data.aws_iam_policy_document.web_execution_secrets.json
}

data "aws_iam_policy_document" "worker_execution_secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      var.worker_database_url_secret_arn,
      var.ai_gateway_key_secret_arn,
      var.pii_dlp_token_secret_arn,
      var.prompt_injection_classifier_token_secret_arn,
      var.document_processor_token_secret_arn,
      var.notification_webhook_secret_arn,
    ]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = var.secret_kms_key_arns
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "worker_execution_secrets" {
  role   = aws_iam_role.worker_execution.id
  policy = data.aws_iam_policy_document.worker_execution_secrets.json
}

data "aws_iam_policy_document" "reviewer_execution_secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      var.review_database_url_secret_arn,
      var.review_service_shared_secret_arn,
      var.approval_token_secret_arn,
    ]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = var.secret_kms_key_arns
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "reviewer_execution_secrets" {
  role   = aws_iam_role.reviewer_execution.id
  policy = data.aws_iam_policy_document.reviewer_execution_secrets.json
}

resource "aws_iam_role" "web_task" {
  name_prefix        = "${local.prefix}-web-task-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role" "worker_task" {
  name_prefix        = "${local.prefix}-worker-task-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role" "reviewer_task" {
  name_prefix        = "${local.prefix}-reviewer-task-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "web_task_data" {
  statement {
    actions = [
      "s3:PutObject",
      "s3:PutObjectTagging",
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]
    resources = ["${aws_s3_bucket.documents.arn}/*/*/quarantine/*"]
  }
  statement {
    actions   = ["kms:Encrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.data.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.aws_region}.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values   = [aws_s3_bucket.documents.arn, "${aws_s3_bucket.documents.arn}/*"]
    }
  }
}

resource "aws_iam_role_policy" "web_task_data" {
  role   = aws_iam_role.web_task.id
  policy = data.aws_iam_policy_document.web_task_data.json
}

data "aws_iam_policy_document" "worker_task_data" {
  statement {
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "s3:PutObjectTagging",
      "s3:PutObjectVersionTagging",
    ]
    resources = ["${aws_s3_bucket.documents.arn}/*/*/quarantine/*"]
  }
  statement {
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
      "s3:PutObjectTagging",
      "s3:PutObjectVersionTagging",
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]
    resources = ["${aws_s3_bucket.documents.arn}/*/*/clean/*"]
  }
  statement {
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.data.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.aws_region}.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values   = [aws_s3_bucket.documents.arn, "${aws_s3_bucket.documents.arn}/*"]
    }
  }
}

resource "aws_iam_role_policy" "worker_task_data" {
  role   = aws_iam_role.worker_task.id
  policy = data.aws_iam_policy_document.worker_task_data.json
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${local.prefix}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.web_execution.arn
  task_role_arn            = aws_iam_role.web_task.arn

  container_definitions = jsonencode([{
    name         = "web"
    image        = var.web_image
    essential    = true
    portMappings = [{ containerPort = 3000, hostPort = 3000, protocol = "tcp" }]
    environment = concat(local.common_environment, [
      { name = "AUTH_MODE", value = "oidc" },
      { name = "APP_BASE_URL", value = var.app_base_url },
      { name = "OIDC_ISSUER", value = var.oidc_issuer },
      { name = "OIDC_AUDIENCE", value = var.oidc_audience },
      { name = "OIDC_JWKS_URL", value = var.oidc_jwks_url },
      { name = "OIDC_AUTHORIZATION_URL", value = var.oidc_authorization_url },
      { name = "OIDC_TOKEN_URL", value = var.oidc_token_url },
      { name = "OIDC_CLIENT_ID", value = var.oidc_client_id },
      { name = "OIDC_REVIEW_AUDIENCE", value = var.oidc_review_audience },
      { name = "OIDC_REVIEW_RESOURCE_PARAMETER", value = var.oidc_review_resource_parameter },
      { name = "OIDC_REVIEW_SCOPE", value = var.oidc_review_scope },
      { name = "OIDC_REVIEW_REQUIRED_ACR", value = var.oidc_review_required_acr },
      { name = "REVIEW_SERVICE_URL", value = "http://reviewer.${aws_service_discovery_private_dns_namespace.internal.name}:3100" },
      { name = "REVIEW_SERVICE_ALLOWED_HOST", value = "reviewer.${aws_service_discovery_private_dns_namespace.internal.name}" },
      { name = "REVIEW_SERVICE_ALLOW_ENCRYPTED_HTTP", value = "true" },
      { name = "MCP_ALLOWED_HOSTS", value = var.public_hostname },
      { name = "MCP_ALLOWED_ORIGINS", value = var.public_hostname },
    ])
    secrets = [
      { name = "DATABASE_URL", valueFrom = var.database_url_secret_arn },
      { name = "AI_GATEWAY_API_KEY", valueFrom = var.ai_gateway_key_secret_arn },
      { name = "PII_DLP_TOKEN", valueFrom = var.pii_dlp_token_secret_arn },
      { name = "PROMPT_INJECTION_CLASSIFIER_TOKEN", valueFrom = var.prompt_injection_classifier_token_secret_arn },
      { name = "REVIEW_SERVICE_SHARED_SECRET", valueFrom = var.review_service_shared_secret_arn },
      { name = "OIDC_CLIENT_SECRET", valueFrom = var.oidc_client_secret_arn },
      { name = "SESSION_SECRET", valueFrom = var.session_secret_arn },
      { name = "HEALTH_DETAIL_TOKEN", valueFrom = var.health_detail_token_secret_arn },
    ]
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.web.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "web"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "reviewer" {
  family                   = "${local.prefix}-reviewer"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.reviewer_execution.arn
  task_role_arn            = aws_iam_role.reviewer_task.arn

  container_definitions = jsonencode([{
    name         = "reviewer"
    image        = var.reviewer_image
    essential    = true
    portMappings = [{ containerPort = 3100, hostPort = 3100, protocol = "tcp" }]
    environment = [
      { name = "AWS_REGION", value = var.aws_region },
      { name = "OIDC_ISSUER", value = var.oidc_issuer },
      { name = "OIDC_JWKS_URL", value = var.oidc_jwks_url },
      { name = "OIDC_CLIENT_ID", value = var.oidc_client_id },
      { name = "OIDC_REVIEW_AUDIENCE", value = var.oidc_review_audience },
      { name = "OIDC_REVIEW_SCOPE", value = var.oidc_review_scope },
      { name = "OIDC_REVIEW_REQUIRED_ACR", value = var.oidc_review_required_acr },
      { name = "PORT", value = "3100" },
    ]
    secrets = [
      { name = "REVIEW_DATABASE_URL", valueFrom = var.review_database_url_secret_arn },
      { name = "REVIEW_SERVICE_SHARED_SECRET", valueFrom = var.review_service_shared_secret_arn },
      { name = "APPROVAL_TOKEN_SECRET", valueFrom = var.approval_token_secret_arn },
    ]
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 20
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.reviewer.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "reviewer"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.prefix}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.worker_execution.arn
  task_role_arn            = aws_iam_role.worker_task.arn

  container_definitions = jsonencode([{
    name      = "worker"
    image     = var.worker_image
    essential = true
    environment = concat(local.common_environment, [
      { name = "CLAMAV_HOST", value = var.clamav_host },
      { name = "CLAMAV_PORT", value = "3310" },
      { name = "DOCUMENT_PROCESSOR_URL", value = var.document_processor_url },
      { name = "DOCUMENT_PROCESSOR_DATA_REGION", value = var.document_processor_data_region },
      { name = "DOCUMENT_PROCESSOR_ALLOWED_HOSTS", value = var.document_processor_allowed_hosts },
      { name = "NOTIFICATION_WEBHOOK_URL", value = var.notification_webhook_url },
      { name = "REQUIRE_NOTIFICATION_WEBHOOK", value = "true" },
    ])
    secrets = [
      { name = "DATABASE_URL", valueFrom = var.worker_database_url_secret_arn },
      { name = "AI_GATEWAY_API_KEY", valueFrom = var.ai_gateway_key_secret_arn },
      { name = "PII_DLP_TOKEN", valueFrom = var.pii_dlp_token_secret_arn },
      { name = "PROMPT_INJECTION_CLASSIFIER_TOKEN", valueFrom = var.prompt_injection_classifier_token_secret_arn },
      { name = "DOCUMENT_PROCESSOR_TOKEN", valueFrom = var.document_processor_token_secret_arn },
      { name = "NOTIFICATION_WEBHOOK_SECRET", valueFrom = var.notification_webhook_secret_arn },
    ]
    healthCheck = {
      command = [
        "CMD-SHELL",
        "node -e \"const s=require('node:fs').statSync('/tmp/taxops-worker-heartbeat');process.exit(Date.now()-s.mtimeMs<120000?0:1)\"",
      ]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.worker.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "worker"
      }
    }
  }])
}

resource "aws_ecs_service" "web" {
  name                               = "web"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.web.arn
  desired_count                      = 2
  launch_type                        = "FARGATE"
  health_check_grace_period_seconds  = 60
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  enable_execute_command             = false

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = "web"
    container_port   = 3000
  }
}

resource "aws_ecs_service" "reviewer" {
  name                               = "reviewer"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.reviewer.arn
  desired_count                      = 2
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  enable_execute_command             = false

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }
  service_registries {
    registry_arn   = aws_service_discovery_service.reviewer.arn
    container_name = "reviewer"
    container_port = 3100
  }
}

resource "aws_ecs_service" "worker" {
  name                               = "worker"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.worker.arn
  desired_count                      = 2
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200
  enable_execute_command             = false

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_heartbeat" {
  alarm_name          = "${local.prefix}-worker-heartbeat"
  alarm_description   = "The worker could not refresh its container heartbeat."
  namespace           = "TaxOps/${local.prefix}"
  metric_name         = "WorkerHeartbeatFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_sns_topic_arns
}

resource "aws_cloudwatch_dashboard" "operations" {
  dashboard_name = "${local.prefix}-operations"
  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "ECS CPU and memory"
          region = var.aws_region
          period = 300
          metrics = [
            ["AWS/ECS", "CPUUtilization", "ClusterName", aws_ecs_cluster.main.name, "ServiceName", aws_ecs_service.web.name],
            [".", "MemoryUtilization", ".", ".", ".", "."],
            ["AWS/ECS", "CPUUtilization", "ClusterName", aws_ecs_cluster.main.name, "ServiceName", aws_ecs_service.worker.name],
            [".", "MemoryUtilization", ".", ".", ".", "."],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "AI latency and cost"
          region = var.aws_region
          period = 300
          stat   = "p95"
          metrics = [
            ["TaxOps/${local.prefix}", "AiRunLatencyMs"],
            ["TaxOps/${local.prefix}", "AiEstimatedCostKrw", { stat = "Sum", yAxis = "right" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 24
        height = 6
        properties = {
          title  = "AI and worker failures"
          region = var.aws_region
          period = 300
          stat   = "Sum"
          metrics = [
            ["TaxOps/${local.prefix}", "AiRunFailed"],
            [".", "WorkerJobFailed"],
            [".", "WorkerHeartbeatFailed"],
          ]
        }
      },
    ]
  })
}

resource "aws_appautoscaling_target" "web" {
  max_capacity       = 8
  min_capacity       = 2
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.web.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "web_cpu" {
  name               = "${local.prefix}-web-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.web.resource_id
  scalable_dimension = aws_appautoscaling_target.web.scalable_dimension
  service_namespace  = aws_appautoscaling_target.web.service_namespace
  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
