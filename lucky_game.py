#!/usr/bin/python3
import random

def input_game_type():
  print("1 福彩\n2 体彩\nq 退出")
  game_type = input(":")
  if game_type == "1" or game_type == "2":
    return int(game_type)
  elif game_type == "q":
    exit()
  else:
    input_game_type()

def input_game_times():
  game_times = input("注数:")
  if game_times == "q":
    exit()
  elif game_times.isdigit() and int(game_times) > 0:
    return int(game_times)
  else:
    print("未知选项")
    input_game_times()
  return game_times

def input_is_end():
  print("1 继续游戏\n2 重新开始\nq 退出游戏")
  is_end = input(":")
  if is_end == "1" or is_end == "2":
    return is_end
  elif is_end == "q":
    exit()
  else:
    input_game_type()

def begin_lucky(game_type, game_times): 
  game_result = []
  for times in range(game_times):
    result_blue = []
    result_red = []
    blue_ball = list(range(1, 36))
    red_ball = list(range(1, 17 if game_type == 1 else 13))
    # 篮球
    for i in range(6 if game_type == 1 else 5):
      random_blue = random.choice(blue_ball)
      blue_ball.remove(random_blue)
      result_blue.append(random_blue)
    result_blue.sort()
    # 红球
    for i in range(1 if game_type == 1 else 2):
      random_red = random.choice(red_ball)
      red_ball.remove(random_red)
      result_red.append(random_red)
    result_red.sort()
    item = {'blue': result_blue, 'red': result_red}
    game_result.append(item)
  return game_result

def begin_game():
  print("======= 选择游戏 q退出程序 ========")
  game_type = input_game_type()
  while True:
    print("\n======= 输入注数 q退出程序 ========")
    game_times = input_game_times()
    game_result = begin_lucky(game_type, game_times)

    print("\n=======     抽取结果     ========")
    for item in game_result:
      result_blue_str = " ".join("{:02d}".format(int(ball)) for ball in item['blue'])
      result_red_str = " ".join("{:02d}".format(int(ball)) for ball in item['red'])
      print(result_blue_str + " | " + result_red_str)

    print("\n======= 是否继续 q退出程序 ========")
    is_end = input_is_end()
    if is_end == "2":
      begin_game()

if __name__ == "__main__":
  begin_game()