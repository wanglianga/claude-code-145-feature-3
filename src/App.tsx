import React, { useEffect } from 'react'
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Button, Dropdown, Layout, Menu, Space, Tag, Typography } from 'antd'
import {
  AlertOutlined,
  ClockCircleOutlined,
  IdcardOutlined,
  LogoutOutlined,
  SafetyOutlined,
  SlidersOutlined,
  TeamOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { useStore } from './store/useStore'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import EventDetailPage from './pages/EventDetailPage'
import EldersPage from './pages/EldersPage'
import ProfilesPage from './pages/ProfilesPage'
import ThresholdReviewPage from './pages/ThresholdReviewPage'
import FamilyPortalPage from './pages/FamilyPortalPage'

const { Header, Sider, Content } = Layout
const { Text } = Typography

/** 全局 tick：每秒检查升级情形（家属超时等） */
function useTicker() {
  const tick = useStore((s) => s.tick)
  useEffect(() => {
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [tick])
}

const CommunityShell: React.FC = () => {
  const nav = useNavigate()
  const loc = useLocation()
  const session = useStore((s) => s.session)!
  const logout = useStore((s) => s.logout)
  const fastForward = useStore((s) => s.fastForward)
  const events = useStore((s) => s.events)
  const activeCount = events.filter((e) => e.status !== 'closed').length

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="light" width={208}>
        <div style={{ padding: 16, fontWeight: 700 }}>
          <SafetyOutlined /> 手环告警处置
        </div>
        <Menu
          mode="inline"
          selectedKeys={[loc.pathname.startsWith('/events') ? '/' : loc.pathname]}
          onClick={(e) => nav(e.key)}
          items={[
            { key: '/', icon: <AlertOutlined />, label: `告警工作台（${activeCount}）` },
            { key: '/elders', icon: <TeamOutlined />, label: '老人档案与设备' },
            { key: '/thresholds', icon: <SlidersOutlined />, label: '误报阈值调整' },
            { key: '/profiles', icon: <IdcardOutlined />, label: '照护画像' },
          ]}
        />
      </Sider>
      <Layout>
        <Header style={{ background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px' }}>
          <Space>
            <Tag color="geekblue">社区值班端</Tag>
            <Text type="secondary">{dayjs(useStore.getState().now()).format('YYYY-MM-DD HH:mm')}</Text>
            <Dropdown
              menu={{
                items: [1, 5, 30].map((m) => ({ key: m, label: `快进 ${m} 分钟` })),
                onClick: ({ key }) => fastForward(Number(key)),
              }}
            >
              <Button size="small" icon={<ClockCircleOutlined />}>
                演示时间快进
              </Button>
            </Dropdown>
          </Space>
          <Space>
            <Text>{session.userName}</Text>
            <Button size="small" icon={<LogoutOutlined />} onClick={logout}>
              退出
            </Button>
          </Space>
        </Header>
        <Content style={{ padding: 16, overflow: 'auto' }}>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/events/:id" element={<EventDetailPage />} />
            <Route path="/elders" element={<EldersPage />} />
            <Route path="/thresholds" element={<ThresholdReviewPage />} />
            <Route path="/profiles" element={<ProfilesPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  )
}

const App: React.FC = () => {
  const session = useStore((s) => s.session)
  useTicker()
  if (!session) return <LoginPage />
  if (session.role === 'family') return <FamilyPortalPage />
  return (
    <HashRouter>
      <CommunityShell />
    </HashRouter>
  )
}

export default App
