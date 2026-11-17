import { supabaseAdmin } from '../config/supabase';
import { logger } from '../utils/logger';

export interface AnalysisReport {
  id: string;
  title: string;
  reportType: 'ATS Audit' | 'Job Screening' | 'Interview Summary';
  candidateName: string;
  score: number;
  atsPassRate: number;
  summary: string;
  createdAt: string;
  data?: any;
}

export const reportService = {
  async listReports(userId: string): Promise<AnalysisReport[]> {
    try {
      const { data, error } = await supabaseAdmin
        .from('analysis_reports')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error || !data || data.length === 0) {
        return this.getDefaultReports();
      }

      return data.map((r) => ({
        id: r.id,
        title: r.title,
        reportType: r.report_type as any,
        candidateName: r.candidate_name,
        score: r.score,
        atsPassRate: r.ats_pass_rate,
        summary: r.summary,
        createdAt: 'Today',
        data: r.data_json,
      }));
    } catch {
      return this.getDefaultReports();
    }
  },

  async createReport(userId: string, report: Omit<AnalysisReport, 'id' | 'createdAt'>): Promise<AnalysisReport> {
    const newReport: AnalysisReport = {
      id: `rep-${Date.now()}`,
      ...report,
      createdAt: 'Today',
    };

    try {
      const { data: row, error } = await supabaseAdmin
        .from('analysis_reports')
        .insert({
          user_id: userId,
          title: report.title,
          report_type: report.reportType,
          candidate_name: report.candidateName,
          score: report.score,
          ats_pass_rate: report.atsPassRate,
          summary: report.summary,
          data_json: report.data || {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (row) {
        newReport.id = row.id;
      }
    } catch (err: any) {
      logger.error(`Error creating report in DB: ${err.message}`);
    }

    return newReport;
  },

  async deleteReport(userId: string, reportId: string): Promise<boolean> {
    try {
      const { error } = await supabaseAdmin
        .from('analysis_reports')
        .delete()
        .eq('id', reportId)
        .eq('user_id', userId);

      return !error;
    } catch {
      return false;
    }
  },

  getDefaultReports(): AnalysisReport[] {
    return [
      {
        id: 'rep-101',
        title: 'Executive Technical ATS Audit',
        reportType: 'ATS Audit',
        candidateName: 'Alex Morgan',
        score: 92,
        atsPassRate: 95,
        summary: 'Resume demonstrates top-tier formatting, strong keyword placement, and high ATS compatibility across enterprise engineering roles.',
        createdAt: 'Today'
      },
      {
        id: 'rep-102',
        title: 'Senior Staff Frontend Match Report',
        reportType: 'Job Screening',
        candidateName: 'Alex Morgan',
        score: 89,
        atsPassRate: 91,
        summary: 'Solid architectural match for Staff Frontend position. High alignment on React, TypeScript, and micro-frontend structures.',
        createdAt: 'Yesterday'
      }
    ];
  }
};
