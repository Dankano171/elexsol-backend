-- migrations/002_account_integrations.sql
CREATE TABLE account_integrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL CHECK (provider IN ('zoho', 'whatsapp', 'quickbooks')),
    account_email VARCHAR(255) NOT NULL,
    account_id VARCHAR(255),
    encrypted_access_token BYTEA NOT NULL,
    encrypted_refresh_token BYTEA,
    token_expires_at TIMESTAMPTZ,
    scopes TEXT[] DEFAULT '{}',
    webhook_secret VARCHAR(255),
    webhook_url VARCHAR(500),
    settings JSONB DEFAULT '{}',
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('active', 'expired', 'revoked', 'pending')),
    last_sync_at TIMESTAMPTZ,
    sync_status VARCHAR(50) DEFAULT 'idle' CHECK (sync_status IN ('idle', 'syncing', 'failed')),
    sync_error TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Ensure unique active integration per provider per business
    UNIQUE(business_id, provider, account_email)
);

CREATE INDEX idx_integrations_business ON account_integrations(business_id);
CREATE INDEX idx_integrations_provider ON account_integrations(provider);
CREATE INDEX idx_integrations_status ON account_integrations(status);
CREATE INDEX idx_integrations_sync ON account_integrations(sync_status) WHERE sync_status = 'syncing';

-- migrations/003_notification_digests.sql
CREATE TABLE notification_digests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL CHECK (type IN ('success', 'action_required', 'integration', 'regulatory')),
    title VARCHAR(255) NOT NULL,
    summary TEXT,
    items JSONB NOT NULL DEFAULT '[]',
    priority VARCHAR(20) NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    metadata JSONB DEFAULT '{}',
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    sent_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_digests_business ON notification_digests(business_id, status, created_at);
CREATE INDEX idx_digests_type ON notification_digests(type, priority);

-- migrations/004_webhook_events.sql
CREATE TABLE webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_id VARCHAR(100) NOT NULL,
    integration_id UUID REFERENCES account_integrations(id) ON DELETE SET NULL,
    provider VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL,
    headers JSONB,
    ip VARCHAR(45),
    status VARCHAR(50) DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
    error_message TEXT,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_webhooks_integration ON webhook_events(integration_id, created_at DESC);
CREATE INDEX idx_webhooks_status ON webhook_events(status) WHERE status = 'processing';

-- migrations/005_regulatory_logs.sql
CREATE TABLE regulatory_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
    submission_type VARCHAR(50) NOT NULL,
    request_payload JSONB,
    response_payload JSONB,
    status VARCHAR(50) NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'failed')),
    error_code VARCHAR(50),
    error_message TEXT,
    irn VARCHAR(100),
    csid VARCHAR(100),
    signature TEXT,
    processing_time_ms INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX idx_regulatory_business ON regulatory_logs(business_id, created_at DESC);
CREATE INDEX idx_regulatory_status ON regulatory_logs(status) WHERE status = 'pending';
CREATE INDEX idx_regulatory_irn ON regulatory_logs(irn) WHERE irn IS NOT NULL;

-- migrations/006_api_logs.sql
CREATE TABLE api_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id VARCHAR(100),
    business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    method VARCHAR(10),
    path VARCHAR(500),
    status INTEGER,
    response_time INTEGER,
    user_agent TEXT,
    ip VARCHAR(45),
    webhook_status VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_api_logs_time ON api_logs(created_at DESC);
CREATE INDEX idx_api_logs_business ON api_logs(business_id, created_at DESC);
CREATE INDEX idx_api_logs_errors ON api_logs(status) WHERE status >= 500;

-- migrations/007_admin_views.sql
CREATE VIEW admin_business_summary AS
SELECT 
    DATE_TRUNC('day', b.created_at) as signup_date,
    b.turnover_band,
    b.region,
    COUNT(*) as new_businesses,
    COUNT(CASE WHEN b.status = 'active' THEN 1 END) as active_businesses,
    COUNT(DISTINCT i.id) as total_invoices,
    COALESCE(SUM(i.total_amount), 0) as total_revenue
FROM businesses b
LEFT JOIN invoices i ON i.business_id = b.id 
    AND i.created_at >= NOW() - INTERVAL '30 days'
GROUP BY DATE_TRUNC('day', b.created_at), b.turnover_band, b.region;

CREATE MATERIALIZED VIEW admin_weekly_metrics AS
SELECT 
    DATE_TRUNC('week', created_at) as week,
    COUNT(DISTINCT business_id) as active_businesses,
    COUNT(*) as total_invoices,
    SUM(total_amount) as invoice_volume,
    AVG(EXTRACT(DAY FROM (payment_date - issue_date))) as avg_payment_days,
    COUNT(DISTINCT customer_tin) as unique_customers
FROM invoices
WHERE created_at >= NOW() - INTERVAL '90 days'
GROUP BY DATE_TRUNC('week', created_at)
WITH DATA;

CREATE UNIQUE INDEX idx_admin_weekly_metrics_week ON admin_weekly_metrics(week);
