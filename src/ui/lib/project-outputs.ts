import type { Goal, Task } from '@shared/types'

export interface ProjectOutputFile {
  name: string
  title: string
  path: string
  updatedAt: string
  size: number
  preview?: string
}

export interface ProjectTaskOutput {
  taskId: number
  taskName: string
  result: string
  updatedAt: string
}

export interface ProjectOutputSummary {
  projectObjective: string
  completedGoalCount: number
  totalGoalCount: number
  completedTaskCount: number
  totalTaskCount: number
  primaryFiles: ProjectOutputFile[]
  taskOutputs: ProjectTaskOutput[]
  missingOutputs: string[]
}

function cleanText(value: string): string {
  return value
    .replace(/\*\*/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function clip(value: string, max = 220): string {
  const text = cleanText(value)
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

function filePriority(file: ProjectOutputFile): number {
  const value = `${file.name} ${file.title}`
  if (/final|正式|终稿|report|报告/i.test(value)) return 6
  if (/index|索引|assembly|装配|manifest|清单/i.test(value)) return 5
  if (/acceptance|验收|review|复核/i.test(value)) return 4
  if (/market|opportunity|机会|市场/i.test(value)) return 3
  if (/draft|草稿|trial|试运行/i.test(value)) return 2
  return 1
}

function normalizeFileTitle(file: ProjectOutputFile): ProjectOutputFile {
  const title = file.title
    .replace(/\bmarket\b/gi, '市场')
    .replace(/\breview\b/gi, '复核')
    .replace(/\breport\b/gi, '报告')
    .replace(/\bindex\b/gi, '索引')
    .replace(/\bacceptance\b/gi, '验收')
    .replace(/\btrial\b/gi, '试运行')
    .replace(/\bworker\s*(\d+)\b/gi, '弟子$1')
    .replace(/\s+/g, ' ')
    .trim()
  return { ...file, title }
}

function taskHasVisibleOutput(task: Task): boolean {
  return Boolean(task.lastResult?.trim())
}

export function buildProjectOutputSummary(input: {
  roomGoal?: string | null
  tasks: Task[]
  goals: Goal[]
  files: ProjectOutputFile[]
}): ProjectOutputSummary {
  const completedGoals = input.goals.filter(goal => goal.status === 'completed')
  const completedTasks = input.tasks.filter(task => task.status === 'completed')
  const taskOutputs = completedTasks
    .filter(taskHasVisibleOutput)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.id - a.id)
    .slice(0, 8)
    .map(task => ({
      taskId: task.id,
      taskName: task.name,
      result: clip(task.lastResult ?? ''),
      updatedAt: task.updatedAt,
    }))

  const missingOutputs = input.tasks
    .filter(task => (task.status === 'completed' || task.status === 'active') && !taskHasVisibleOutput(task))
    .sort((a, b) => {
      const statusScore = (task: Task) => task.status === 'completed' ? 0 : 1
      return statusScore(a) - statusScore(b) || b.id - a.id
    })
    .slice(0, 6)
    .map(task => task.name)

  const primaryFiles = [...input.files]
    .map(normalizeFileTitle)
    .sort((a, b) => filePriority(b) - filePriority(a) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 8)

  return {
    projectObjective: clip(input.roomGoal || '等待帮主补充项目目标', 260),
    completedGoalCount: completedGoals.length,
    totalGoalCount: input.goals.length,
    completedTaskCount: completedTasks.length,
    totalTaskCount: input.tasks.length,
    primaryFiles,
    taskOutputs,
    missingOutputs,
  }
}
