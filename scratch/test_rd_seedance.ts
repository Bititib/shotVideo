/**
 * 测试 rd-seedance-2.5-480p 模型通过 MJNewAPI 渠道生成 6 秒视频
 * 直接调用上游 API 测试连通性
 */

const BASE_URL = 'https://mjnewapi.diwdiw.cn';
const API_KEY = 'sk-ypnbPu4siWgwzp5EcpqvDTtU4z6q8gHqP3gYj4FV10kku4it';
const MODEL = 'rd-seedance-2.5 480p';  // 上游模型名（带空格）
const DURATION = 6;

async function testVideoGeneration() {
  console.log(`🎬 测试 rd-seedance-2.5-480p 生成 ${DURATION}s 视频...`);
  console.log(`📡 上游: ${BASE_URL}`);
  console.log(`🔑 Key: ${API_KEY.slice(0, 10)}...${API_KEY.slice(-4)}`);
  console.log(`📦 模型: ${MODEL}`);
  console.log('---');

  try {
    // Step 1: 创建视频生成任务
    console.log('⏳ 正在提交生成任务...');
    const createResp = await fetch(`${BASE_URL}/v1/video/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        prompt: '一只可爱的猫咪在草地上奔跑',
        duration: DURATION,
      }),
    });

    console.log(`📬 创建响应状态: ${createResp.status} ${createResp.statusText}`);
    
    const createText = await createResp.text();
    console.log(`📬 创建响应内容: ${createText.slice(0, 500)}`);

    if (!createResp.ok) {
      console.error('❌ 创建任务失败!');
      
      // 尝试另一种API格式 /v1/videos
      console.log('\n🔄 尝试 /v1/videos 端点...');
      const altResp = await fetch(`${BASE_URL}/v1/videos`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          prompt: '一只可爱的猫咪在草地上奔跑',
          duration: DURATION,
        }),
      });
      console.log(`📬 备用端点响应状态: ${altResp.status} ${altResp.statusText}`);
      const altText = await altResp.text();
      console.log(`📬 备用端点响应内容: ${altText.slice(0, 500)}`);
      
      if (!altResp.ok) {
        console.error('❌ 两种端点均失败!');
        return;
      }
      
      const altData = JSON.parse(altText);
      console.log('✅ 备用端点创建成功:', JSON.stringify(altData, null, 2).slice(0, 300));
      return;
    }

    const createData = JSON.parse(createText);
    const videoId = createData.id || createData.data?.id || createData.task_id;
    console.log(`✅ 任务创建成功! ID: ${videoId}`);

    // Step 2: 轮询任务状态 (最多 5 分钟)
    const maxWait = 5 * 60 * 1000;
    const pollInterval = 5000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await new Promise(r => setTimeout(r, pollInterval));
      
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      
      // 尝试两种轮询端点
      let pollResp = await fetch(`${BASE_URL}/v1/video/generations/${videoId}`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` },
      });
      
      if (!pollResp.ok) {
        pollResp = await fetch(`${BASE_URL}/v1/videos/${videoId}`, {
          headers: { 'Authorization': `Bearer ${API_KEY}` },
        });
      }

      const pollText = await pollResp.text();
      let pollData;
      try {
        pollData = JSON.parse(pollText);
      } catch {
        console.log(`⏳ [${elapsed}s] 轮询响应非 JSON: ${pollText.slice(0, 200)}`);
        continue;
      }

      const status = pollData.status || pollData.data?.status;
      console.log(`⏳ [${elapsed}s] 状态: ${status}`);

      if (status === 'completed' || status === 'succeeded' || status === 'success') {
        console.log('\n🎉 视频生成成功!');
        console.log('📋 完整响应:', JSON.stringify(pollData, null, 2).slice(0, 500));
        
        // 提取视频 URL
        const videoUrl = pollData.video?.url || pollData.data?.video?.url 
          || pollData.output?.video_url || pollData.url;
        if (videoUrl) {
          console.log(`🎬 视频 URL: ${videoUrl}`);
        }
        return;
      }
      
      if (status === 'failed' || status === 'error') {
        console.error('❌ 视频生成失败!');
        console.error('📋 错误详情:', JSON.stringify(pollData, null, 2).slice(0, 500));
        return;
      }
    }

    console.log('⏰ 超时：已等待 5 分钟，任务仍未完成');
  } catch (err: any) {
    console.error('💥 请求异常:', err.message);
  }
}

testVideoGeneration();
