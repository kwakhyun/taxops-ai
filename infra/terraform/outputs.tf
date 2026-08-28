output "documents_bucket" {
  value = aws_s3_bucket.documents.id
}

output "database_endpoint" {
  value     = aws_db_instance.database.endpoint
  sensitive = true
}

output "ecs_cluster_arn" {
  value = aws_ecs_cluster.main.arn
}

output "task_security_group_id" {
  value = aws_security_group.tasks.id
}
