export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      api_keys: {
        Row: {
          created_at: string
          id: string
          key_hash: string
          key_prefix: string
          last_used_at: string | null
          model_id: string
          name: string | null
          revoked_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          key_hash: string
          key_prefix: string
          last_used_at?: string | null
          model_id: string
          name?: string | null
          revoked_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          key_hash?: string
          key_prefix?: string
          last_used_at?: string | null
          model_id?: string
          name?: string | null
          revoked_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_keys_model_id_fkey"
            columns: ["model_id"]
            isOneToOne: false
            referencedRelation: "models"
            referencedColumns: ["id"]
          },
        ]
      }
      datasets: {
        Row: {
          columns: Json | null
          created_at: string
          error: string | null
          id: string
          name: string
          row_count: number | null
          size_bytes: number | null
          status: Database["public"]["Enums"]["dataset_status"]
          storage_path: string
          updated_at: string
          user_id: string
        }
        Insert: {
          columns?: Json | null
          created_at?: string
          error?: string | null
          id?: string
          name: string
          row_count?: number | null
          size_bytes?: number | null
          status?: Database["public"]["Enums"]["dataset_status"]
          storage_path: string
          updated_at?: string
          user_id: string
        }
        Update: {
          columns?: Json | null
          created_at?: string
          error?: string | null
          id?: string
          name?: string
          row_count?: number | null
          size_bytes?: number | null
          status?: Database["public"]["Enums"]["dataset_status"]
          storage_path?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      model_artifacts: {
        Row: {
          created_at: string
          id: string
          job_id: string
          metrics: Json | null
          model_id: string
          storage_path: string
          version: number
        }
        Insert: {
          created_at?: string
          id?: string
          job_id: string
          metrics?: Json | null
          model_id: string
          storage_path: string
          version: number
        }
        Update: {
          created_at?: string
          id?: string
          job_id?: string
          metrics?: Json | null
          model_id?: string
          storage_path?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "model_artifacts_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "training_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "model_artifacts_model_id_fkey"
            columns: ["model_id"]
            isOneToOne: false
            referencedRelation: "models"
            referencedColumns: ["id"]
          },
        ]
      }
      models: {
        Row: {
          algorithm: Database["public"]["Enums"]["model_algorithm"]
          created_at: string
          dataset_id: string
          feature_columns: string[]
          hyperparameters: Json
          id: string
          name: string
          status: Database["public"]["Enums"]["model_status"]
          target_column: string
          task: Database["public"]["Enums"]["model_task"]
          updated_at: string
          user_id: string
        }
        Insert: {
          algorithm: Database["public"]["Enums"]["model_algorithm"]
          created_at?: string
          dataset_id: string
          feature_columns: string[]
          hyperparameters?: Json
          id?: string
          name: string
          status?: Database["public"]["Enums"]["model_status"]
          target_column: string
          task: Database["public"]["Enums"]["model_task"]
          updated_at?: string
          user_id: string
        }
        Update: {
          algorithm?: Database["public"]["Enums"]["model_algorithm"]
          created_at?: string
          dataset_id?: string
          feature_columns?: string[]
          hyperparameters?: Json
          id?: string
          name?: string
          status?: Database["public"]["Enums"]["model_status"]
          target_column?: string
          task?: Database["public"]["Enums"]["model_task"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "models_dataset_id_fkey"
            columns: ["dataset_id"]
            isOneToOne: false
            referencedRelation: "datasets"
            referencedColumns: ["id"]
          },
        ]
      }
      predictions_log: {
        Row: {
          api_key_id: string | null
          created_at: string
          id: number
          input_row_count: number
          latency_ms: number
          model_id: string
          status_code: number
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          id?: never
          input_row_count: number
          latency_ms: number
          model_id: string
          status_code: number
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          id?: never
          input_row_count?: number
          latency_ms?: number
          model_id?: string
          status_code?: number
        }
        Relationships: [
          {
            foreignKeyName: "predictions_log_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "predictions_log_model_id_fkey"
            columns: ["model_id"]
            isOneToOne: false
            referencedRelation: "models"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      training_jobs: {
        Row: {
          attempt: number
          claimed_at: string | null
          claimed_by: string | null
          created_at: string
          error_message: string | null
          finished_at: string | null
          heartbeat_at: string | null
          id: string
          model_id: string
          started_at: string | null
          status: Database["public"]["Enums"]["job_status"]
        }
        Insert: {
          attempt?: number
          claimed_at?: string | null
          claimed_by?: string | null
          created_at?: string
          error_message?: string | null
          finished_at?: string | null
          heartbeat_at?: string | null
          id?: string
          model_id: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["job_status"]
        }
        Update: {
          attempt?: number
          claimed_at?: string | null
          claimed_by?: string | null
          created_at?: string
          error_message?: string | null
          finished_at?: string | null
          heartbeat_at?: string | null
          id?: string
          model_id?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["job_status"]
        }
        Relationships: [
          {
            foreignKeyName: "training_jobs_model_id_fkey"
            columns: ["model_id"]
            isOneToOne: false
            referencedRelation: "models"
            referencedColumns: ["id"]
          },
        ]
      }
      training_metrics: {
        Row: {
          created_at: string
          elapsed_ms: number | null
          epoch: number
          id: number
          job_id: string
          loss: number
          val_loss: number | null
        }
        Insert: {
          created_at?: string
          elapsed_ms?: number | null
          epoch: number
          id?: never
          job_id: string
          loss: number
          val_loss?: number | null
        }
        Update: {
          created_at?: string
          elapsed_ms?: number | null
          epoch?: number
          id?: never
          job_id?: string
          loss?: number
          val_loss?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "training_metrics_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "training_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_training_job: {
        Args: { p_worker_id: string }
        Returns: {
          attempt: number
          claimed_at: string | null
          claimed_by: string | null
          created_at: string
          error_message: string | null
          finished_at: string | null
          heartbeat_at: string | null
          id: string
          model_id: string
          started_at: string | null
          status: Database["public"]["Enums"]["job_status"]
        }[]
        SetofOptions: {
          from: "*"
          to: "training_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      owns_model: { Args: { p_model_id: string }; Returns: boolean }
      reap_stale_jobs: {
        Args: { p_max_attempts?: number; p_stale_after?: string }
        Returns: number
      }
    }
    Enums: {
      dataset_status: "uploading" | "ready" | "invalid"
      job_status: "queued" | "claimed" | "running" | "succeeded" | "failed"
      model_algorithm: "linear_regression" | "logistic_regression"
      model_status: "draft" | "queued" | "training" | "succeeded" | "failed"
      model_task: "regression" | "binary_classification"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      dataset_status: ["uploading", "ready", "invalid"],
      job_status: ["queued", "claimed", "running", "succeeded", "failed"],
      model_algorithm: ["linear_regression", "logistic_regression"],
      model_status: ["draft", "queued", "training", "succeeded", "failed"],
      model_task: ["regression", "binary_classification"],
    },
  },
} as const
