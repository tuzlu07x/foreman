export interface ApprovalRequest {
  requestId: string
  sourceAgent: string
  targetAgent?: string
  targetTool?: string
  args: unknown
  riskScore: number
  riskReasons: string[]
}

export interface ApprovalDecision {
  decision: 'allowed' | 'denied'
  remember?: 'allow' | 'deny'
}

export interface ApprovalService {
  request(req: ApprovalRequest): Promise<ApprovalDecision>
}

export class DenyAllApprovalService implements ApprovalService {
  async request(): Promise<ApprovalDecision> {
    return { decision: 'denied' }
  }
}
